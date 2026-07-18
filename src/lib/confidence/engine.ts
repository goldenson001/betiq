/**
 * Confidence Engine
 * ──────────────────
 * Takes the engine's per-match predictions and builds EIGHT daily parlay tiers
 * calibrated for different risk appetites:
 *
 *   1. safest      — 2-3 legs, each leg probability >= SAFEST_MIN_LEG_PROB
 *                    (default 0.80) AND consensusSources >= SAFEST_MIN_LEG_SOURCES
 *                    (default 2). Target: ~50-65% combined win probability.
 *                    For investors who want high win-rate, low-variance returns.
 *   2. medium_risk — 3-4 legs, each leg probability >= 0.55. Target: ~25-50%
 *                    combined win probability. Balanced growth.
 *   3. high_risk   — 4-5 legs, each leg probability >= 0.40. Target: ~5-20%
 *                    combined win probability. Higher upside, higher variance.
 *   4. mega_odds   — 5-6 legs targeting combined odds >= 20/1. Each leg
 *                    probability >= 0.15. Longshot parlay for lottery-style
 *                    payouts.
 *   5. odds_3_a    — Target combined odds ~3.0 (±25%). Leg count is whatever
 *   6. odds_3_b      it takes — each leg probability >= 0.70 (close-to-no-loss
 *                    picks). Two independent parlays (A and B) so you have a
 *                    choice; B excludes matches already used in A.
 *   7. odds_5_a    — Target combined odds ~5.0 (±25%). Each leg probability
 *   8. odds_5_b      >= 0.60. Same A/B independence rule.
 *
 * Each parlay also gets a Kelly criterion stake (1/8 fraction, capped at 2%
 * of bankroll — parlays are much higher variance than single bets).
 *
 * B4 upgrade: Correlation-aware Kelly. Parlay legs are NOT actually
 * independent — same-league same-day legs share referee/weather/pitch
 * conditions, and 3+ legs within a 2-hour window share pitch-weather
 * correlation. We apply a haircut to combinedProbability before computing
 * Kelly, so effective stake shrinks for correlated parlays.
 *
 * B5 upgrade: No-overlap rule. Each match appears in AT MOST ONE parlay tier
 * per day. Build order: safest → medium → high → mega → odds_3_a → odds_3_b
 * → odds_5_a → odds_5_b. Each tier claims its matchIds and removes them from
 * the pool seen by subsequent tiers. A tier may end up empty if all its
 * eligible matches were claimed by an earlier tier — that's intentional
 * (an empty tier is better than a duplicated leg).
 *
 * Persists all eight parlays to DB. Idempotent: clears existing parlays for
 * the date before re-creating.
 */

import { db } from "@/lib/db";
import { kellyParlay as kellyParlayStake, type KellyResult } from "@/lib/learning/kelly";
import { correlationHaircut } from "@/lib/learning/risk";
import { ENGINE_CONFIG } from "@/lib/config";
import {
  computeLegMLScore,
  bayesianCombinedProb,
  loadAllParlayTierStats,
  loadSourceMLInfo,
  type LegInput,
  type LegMLScore,
  type ParlayTierStatsRow,
  type SourceMLInfo,
} from "@/lib/learning/parlay-ml";
import { loadMarketLeagueClvMap } from "@/lib/learning/feedback";

interface ParlayLeg {
  predictionId: string;
  matchId: string;
  matchLabel: string;
  market: string;
  selection: string;
  odds: number;
  probability: number;
  confidence: number;
  // ── B4: Correlation inputs ──────────────────────────────────────────────
  leagueId?: string | null;
  kickoffUtc?: Date | string | null;
}

interface ParlayCandidate {
  legs: ParlayLeg[];
  combinedProbability: number;
  combinedOdds: number;
  confidence: number; // 0-100
  expectedValue: number;
  // ── B4: Correlation diagnostics ──────────────────────────────────────────
  correlationHaircutMultiplier?: number; // 1.0 = no haircut, 0.5 = halved
  rawCombinedProbability?: number; // before haircut
  // ── ML: per-leg ML scores + Bayesian-adjusted combined probability ────────
  legMLScores?: LegMLScore[];
  mlAdjustedProbability?: number;
  mlScore?: number; // parlay-level reliability (avg of leg reliabilities)
  mlSampleCount?: number;
}

function evaluateParlay(legs: ParlayLeg[]): ParlayCandidate {
  const rawCombinedProbability = legs.reduce((p, l) => p * l.probability, 1);
  const combinedOdds = legs.reduce((o, l) => o * l.odds, 1);
  // ── B4: Apply correlation haircut ──────────────────────────────────────
  // The independence assumption (Π p_i) over-estimates win probability when
  // legs are correlated. Apply a haircut based on same-league pairs and
  // time-clustered legs. Haircut is multiplied INTO the combined probability.
  const haircutMult = correlationHaircut(legs);
  const combinedProbability = rawCombinedProbability * haircutMult;
  const expectedValue = combinedOdds * combinedProbability - 1;
  // Confidence for parlays is a blend: combined probability * sqrt(num legs)
  // (so a 4-leg parlay with 0.7 each leg doesn't get a tiny confidence score)
  const numLegsFactor = Math.sqrt(legs.length);
  const rawConfidence = combinedProbability * numLegsFactor * 0.6 + Math.min(0.4, expectedValue + 0.5);
  const confidence = Math.max(5, Math.min(95, Math.round(rawConfidence * 100)));
  return {
    legs,
    combinedProbability,
    combinedOdds,
    confidence,
    expectedValue,
    correlationHaircutMultiplier: legs.length >= 2 ? haircutMult : undefined,
    rawCombinedProbability: legs.length >= 2 ? rawCombinedProbability : undefined,
  };
}

/**
 * Evaluate a parlay using ML-adjusted probabilities for each leg.
 *
 * Same shape as `evaluateParlay`, but uses each leg's `adjustedProb` (from
 * `computeLegMLScore`) instead of the raw engine `probability`. This means
 * the combined probability reflects BOTH the stated probability AND how much
 * the ML model trusts that probability.
 *
 * Also carries the per-leg ML scores + parlay-level ML score so it can be
 * persisted on the Parlay row for UI display + audit.
 */
function evaluateParlayWithML(
  legs: ParlayLeg[],
  legMLScores: LegMLScore[]
): ParlayCandidate {
  if (legs.length === 0) return evaluateParlay([]);

  // Use ML-adjusted probability for each leg when computing the product.
  const rawCombinedProbability = legs.reduce((p, _, i) => p * legMLScores[i].adjustedProb, 1);
  const combinedOdds = legs.reduce((o, l) => o * l.odds, 1);
  const haircutMult = correlationHaircut(legs);
  const combinedProbability = rawCombinedProbability * haircutMult;
  const expectedValue = combinedOdds * combinedProbability - 1;
  const numLegsFactor = Math.sqrt(legs.length);
  const rawConfidence = combinedProbability * numLegsFactor * 0.6 + Math.min(0.4, expectedValue + 0.5);
  const confidence = Math.max(5, Math.min(95, Math.round(rawConfidence * 100)));

  // Parlay-level ML score = average of leg reliabilities (so a parlay with
  // one weak leg gets penalized even if the other legs are strong).
  const mlScore = legs.length > 0
    ? legMLScores.reduce((s, l) => s + l.reliability, 0) / legs.length
    : 0;

  return {
    legs,
    combinedProbability,
    combinedOdds,
    confidence,
    expectedValue,
    correlationHaircutMultiplier: legs.length >= 2 ? haircutMult : undefined,
    rawCombinedProbability: legs.length >= 2 ? rawCombinedProbability : undefined,
    legMLScores,
    mlScore,
  };
}

/**
 * Generic greedy parlay builder. Starts with the highest-quality leg and
 * adds legs that maximize expected value while keeping each leg's probability
 * above `minLegProb` AND keeping combined probability above `minCombinedProb`.
 *
 * Excludes combo / synthetic markets (bet_builder, win_btts, correct_score)
 * since these overlap with base markets and would double-count signal.
 *
 * B3 upgrade: optional `minConsensus` requires each leg to have at least N
 * independent sources agreeing. Used by the safest tier to enforce multi-
 * source consensus (no single-source "safe" legs).
 */
function buildGreedyParlay(
  allLegs: ParlayLeg[],
  opts: {
    maxLegs: number;
    minLegProb: number;
    minCombinedProb: number;
    minConsensus?: number;
  }
): ParlayCandidate {
  const EXCLUDED = new Set(["bet_builder", "win_btts", "correct_score", "htft"]);
  const eligible = allLegs
    .filter((l) => !EXCLUDED.has(l.market))
    .filter((l) => l.probability >= opts.minLegProb)
    .filter((l) => (opts.minConsensus ?? 0) <= 0 || (l as { consensusSources?: number }).consensusSources !== undefined && (l as { consensusSources?: number }).consensusSources! >= (opts.minConsensus ?? 0))
    .sort((a, b) => b.probability * b.confidence - a.probability * a.confidence);
  if (eligible.length === 0) {
    return evaluateParlay([]);
  }
  const legs: ParlayLeg[] = [eligible[0]];
  const used = new Set<string>([eligible[0].matchId]);
  while (legs.length < opts.maxLegs) {
    let bestGain = -Infinity;
    let bestLeg: ParlayLeg | null = null;
    for (const leg of eligible) {
      if (used.has(leg.matchId)) continue;
      const trial = [...legs, leg];
      const cand = evaluateParlay(trial);
      if (cand.combinedProbability < opts.minCombinedProb) continue;
      // Greedy on expected value — but penalize tiny probability legs
      const gain = cand.expectedValue;
      if (gain > bestGain) {
        bestGain = gain;
        bestLeg = leg;
      }
    }
    if (!bestLeg) break;
    legs.push(bestLeg);
    used.add(bestLeg.matchId);
  }
  return evaluateParlay(legs);
}

/**
 * ML-aware greedy parlay builder. Same structural shape as `buildGreedyParlay`
 * but uses ML reliability scores to:
 *   1. Rank eligible legs (sort by ML reliability desc, not prob × confidence)
 *   2. Compute combined probability using ML-adjusted per-leg probabilities
 *   3. Filter out legs whose ML reliability falls below `minReliability`
 *
 * This is the SAFETY-FIRST version: a 0.80 prob leg from a single low-quality
 * source will rank LOWER than a 0.78 prob leg from 4 high-quality sources in
 * agreement, because the ML score reflects our actual confidence in the
 * probability, not just the probability itself.
 *
 * `legMLMap` is a pre-computed map from predictionId → LegMLScore (computed
 * once per pipeline run for all candidate legs, then reused across tiers).
 */
function buildGreedyParlayML(
  allLegs: ParlayLeg[],
  legMLMap: Map<string, LegMLScore>,
  opts: {
    maxLegs: number;
    minLegProb: number;
    minCombinedProb: number;
    minConsensus?: number;
    minReliability?: number; // ML reliability threshold (default 0 = no threshold)
  }
): ParlayCandidate {
  const EXCLUDED = new Set(["bet_builder", "win_btts", "correct_score", "htft"]);
  const minRel = opts.minReliability ?? 0;

  const eligible = allLegs
    .filter((l) => !EXCLUDED.has(l.market))
    .filter((l) => l.probability >= opts.minLegProb)
    .filter((l) => (opts.minConsensus ?? 0) <= 0 || ((l as { consensusSources?: number }).consensusSources ?? 0) >= (opts.minConsensus ?? 0))
    .filter((l) => {
      const ml = legMLMap.get(l.predictionId);
      return ml ? ml.reliability >= minRel : true;
    })
    // ── ML sort: reliability desc, tiebreak by prob*confidence desc ──────────
    .sort((a, b) => {
      const mlA = legMLMap.get(a.predictionId)?.reliability ?? 0;
      const mlB = legMLMap.get(b.predictionId)?.reliability ?? 0;
      if (Math.abs(mlB - mlA) > 0.001) return mlB - mlA;
      return b.probability * b.confidence - a.probability * a.confidence;
    });

  if (eligible.length === 0) {
    return evaluateParlay([]);
  }

  const legs: ParlayLeg[] = [eligible[0]];
  const used = new Set<string>([eligible[0].matchId]);
  while (legs.length < opts.maxLegs) {
    let bestGain = -Infinity;
    let bestLeg: ParlayLeg | null = null;
    for (const leg of eligible) {
      if (used.has(leg.matchId)) continue;
      const trial = [...legs, leg];
      const trialML = trial.map((l) => legMLMap.get(l.predictionId)!).filter(Boolean);
      if (trialML.length !== trial.length) continue; // missing ML score — skip
      const cand = evaluateParlayWithML(trial, trialML);
      if (cand.combinedProbability < opts.minCombinedProb) continue;
      // Greedy on expected value — but the EV is now computed with ML-adjusted
      // probabilities, so safer legs (higher reliability) naturally score
      // higher when their probabilities are similar.
      const gain = cand.expectedValue;
      if (gain > bestGain) {
        bestGain = gain;
        bestLeg = leg;
      }
    }
    if (!bestLeg) break;
    legs.push(bestLeg);
    used.add(bestLeg.matchId);
  }

  const finalML = legs.map((l) => legMLMap.get(l.predictionId)!).filter(Boolean);
  if (finalML.length !== legs.length) {
    // Fallback: if any leg is missing an ML score, evaluate without ML
    return evaluateParlay(legs);
  }
  return evaluateParlayWithML(legs, finalML);
}

/**
 * ML-aware target-odds builder. Same shape as `buildTargetOddsParlay` but
 * uses ML reliability to rank eligible legs and ML-adjusted probabilities
 * for the combined-odds math. Picks the highest-ML legs first, then stops
 * once combined odds reaches the target range.
 */
function buildTargetOddsParlayML(
  allLegs: ParlayLeg[],
  legMLMap: Map<string, LegMLScore>,
  opts: {
    targetOdds: number;
    tolerance?: number;
    minLegProb: number;
    maxLegs?: number;
    minLegs?: number;
    minReliability?: number;
  },
  usedMatchIds: Set<string>
): ParlayCandidate {
  const EXCLUDED = new Set(["bet_builder", "win_btts", "correct_score", "htft"]);
  const tolerance = opts.tolerance ?? 0.25;
  const maxLegs = opts.maxLegs ?? 8;
  const minLegs = opts.minLegs ?? 2;
  const minRel = opts.minReliability ?? 0;
  const target = opts.targetOdds;
  const lowerBound = target * (1 - tolerance);
  const upperBound = target * (1 + tolerance);

  // Eligible legs: not excluded, not already used, prob >= minLegProb,
  // ML reliability >= minReliability.
  // Sort by ML reliability desc (so we pick the safest legs first), with
  // tiebreak by odds desc (higher-odds legs get us to target faster).
  const eligible = allLegs
    .filter((l) => !EXCLUDED.has(l.market))
    .filter((l) => !usedMatchIds.has(l.matchId))
    .filter((l) => l.probability >= opts.minLegProb)
    .filter((l) => {
      const ml = legMLMap.get(l.predictionId);
      return ml ? ml.reliability >= minRel : true;
    })
    .sort((a, b) => {
      const mlA = legMLMap.get(a.predictionId)?.reliability ?? 0;
      const mlB = legMLMap.get(b.predictionId)?.reliability ?? 0;
      if (Math.abs(mlB - mlA) > 0.001) return mlB - mlA;
      if (Math.abs(b.odds - a.odds) > 0.01) return b.odds - a.odds;
      return b.probability * b.confidence - a.probability * a.confidence;
    });

  if (eligible.length === 0) {
    return evaluateParlay([]);
  }

  const legs: ParlayLeg[] = [];
  const localUsed = new Set<string>(usedMatchIds);
  let currentOdds = 1.0;

  for (const leg of eligible) {
    if (legs.length >= maxLegs) break;
    if (localUsed.has(leg.matchId)) continue;

    const projectedOdds = currentOdds * leg.odds;
    if (legs.length >= minLegs && projectedOdds > upperBound) {
      continue;
    }

    legs.push(leg);
    localUsed.add(leg.matchId);
    currentOdds = projectedOdds;

    if (legs.length >= minLegs && currentOdds >= lowerBound) break;
  }

  if (legs.length === 0) return evaluateParlay([]);

  const finalML = legs.map((l) => legMLMap.get(l.predictionId)!).filter(Boolean);
  if (finalML.length !== legs.length) {
    return evaluateParlay(legs);
  }
  return evaluateParlayWithML(legs, finalML);
}

/**
 * Mega-odds builder — targets combined odds >= 20/1 by stacking lower-probability
 * legs. Uses a 3-tier fallback so we ALWAYS produce a Mega Odds card when any
 * predictions exist (previously a strict 0.15-0.50 band could leave this tier empty
 * and the old card would be wiped on pipeline re-run).
 *
 * Tier 1 — pure longshots: probability in [0.10, 0.50], sorted by odds desc
 * Tier 2 — mid-probability boost: probability in [0.30, 0.60] to push combined odds
 * Tier 3 — best-available fallback: any non-excluded leg, sorted by odds desc,
 *          at least 3 legs (to keep the "mega" feel) even if combined odds < 20
 */
function buildMegaOddsParlay(allLegs: ParlayLeg[]): ParlayCandidate {
  const EXCLUDED = new Set(["bet_builder", "win_btts", "correct_score", "htft"]);
  const TARGET_ODDS = 20.0;
  const MAX_LEGS = 6;
  const MIN_LEGS = 3;

  const legs: ParlayLeg[] = [];
  const used = new Set<string>();

  // Tier 1 — pure longshots (prob 0.10-0.50, highest odds first)
  const longshots = allLegs
    .filter((l) => !EXCLUDED.has(l.market))
    .filter((l) => l.probability >= 0.10 && l.probability <= 0.50)
    .sort((a, b) => b.odds - a.odds);
  for (const leg of longshots) {
    if (legs.length >= MAX_LEGS) break;
    if (used.has(leg.matchId)) continue;
    legs.push(leg);
    used.add(leg.matchId);
    if (evaluateParlay(legs).combinedOdds >= TARGET_ODDS) break;
  }

  // Tier 2 — mid-probability boost (prob 0.30-0.60) if we haven't hit target
  if (legs.length < MAX_LEGS && evaluateParlay(legs).combinedOdds < TARGET_ODDS) {
    const mid = allLegs
      .filter((l) => !EXCLUDED.has(l.market))
      .filter((l) => l.probability >= 0.30 && l.probability <= 0.60)
      .filter((l) => !used.has(l.matchId))
      .sort((a, b) => b.odds - a.odds);
    for (const leg of mid) {
      if (legs.length >= MAX_LEGS) break;
      legs.push(leg);
      used.add(leg.matchId);
      if (evaluateParlay(legs).combinedOdds >= TARGET_ODDS) break;
    }
  }

  // Tier 3 — best-available fallback: ANY non-excluded leg, regardless of prob,
  // so we always produce a Mega Odds card when there are any predictions today.
  // This prevents the mega_odds row from disappearing on pipeline re-runs.
  if (legs.length < MIN_LEGS) {
    legs.length = 0;
    used.clear();
    const anyLeg = allLegs
      .filter((l) => !EXCLUDED.has(l.market))
      .sort((a, b) => b.odds - a.odds);
    for (const leg of anyLeg) {
      if (legs.length >= Math.max(MIN_LEGS, Math.min(MAX_LEGS, 4))) break;
      if (used.has(leg.matchId)) continue;
      legs.push(leg);
      used.add(leg.matchId);
      if (legs.length >= MIN_LEGS && evaluateParlay(legs).combinedOdds >= TARGET_ODDS) break;
    }
  }

  // If still nothing (no eligible legs at all), return empty
  if (legs.length === 0) return evaluateParlay([]);
  return evaluateParlay(legs);
}

// ──────────────────────────────────────────────────────────────────────────────
// B6: Target-odds parlays (odds_3_a/b, odds_5_a/b)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a parlay that targets a specific combined odds (e.g. 3.0 or 5.0) by
 * stacking the highest-quality legs available. Unlike the risk-tier parlays
 * above, this builder does NOT care about leg count — it cares about getting
 * the combined odds as close as possible to `targetOdds` while using only
 * high-probability legs (so "close to no chance of losing" per user brief).
 *
 * Algorithm:
 *   1. Filter legs to those with probability >= minLegProb.
 *   2. Sort by (probability * confidence) desc — best picks first.
 *   3. Greedily add legs while:
 *        - combined odds < targetOdds * (1 + tolerance)  [stop once we hit target]
 *        - the next leg's matchId isn't already in the parlay
 *        - we haven't exceeded maxLegs (safety cap)
 *   4. If after adding all eligible legs we still haven't reached the lower
 *      bound, accept the best we got (rare — only on thin days).
 *
 * Key insight: high-probability legs have LOW odds (e.g. 0.92 prob → 1.03
 * odds). So to reach combined odds of 3.0, we typically need 2-4 legs, not
 * 6+ as the first attempt produced. The greedy loop naturally stops once
 * the cumulative product crosses the lower bound.
 *
 * `usedMatchIds` is mutated — the caller passes the running set so this
 * parlay doesn't reuse matches already claimed by earlier parlays (B5
 * no-overlap rule).
 */
function buildTargetOddsParlay(
  allLegs: ParlayLeg[],
  opts: {
    targetOdds: number;
    /** Acceptable range around target. Default 0.25 = ±25% (e.g. 3.0 → 2.25–3.75). */
    tolerance?: number;
    minLegProb: number;
    /** Hard cap on leg count. Default 8. */
    maxLegs?: number;
    /** Minimum legs to keep even if we can't hit target. Default 2. */
    minLegs?: number;
  },
  usedMatchIds: Set<string>
): ParlayCandidate {
  const EXCLUDED = new Set(["bet_builder", "win_btts", "correct_score", "htft"]);
  const tolerance = opts.tolerance ?? 0.25;
  const maxLegs = opts.maxLegs ?? 8;
  const minLegs = opts.minLegs ?? 2;
  const target = opts.targetOdds;
  const lowerBound = target * (1 - tolerance);
  const upperBound = target * (1 + tolerance);

  // Eligible legs: not excluded, not already used, prob >= minLegProb.
  // Sort by ODDS DESCENDING so we pick higher-odds (but still high-prob) legs
  // first — this gets the combined product to the target faster. Among legs
  // with similar odds, the higher-probability one comes first via tiebreak.
  // (Previously sorted by quality desc, which picked all 1.03 legs first and
  // never reached the target — produced 6 legs at combined odds 1.22.)
  const eligible = allLegs
    .filter((l) => !EXCLUDED.has(l.market))
    .filter((l) => !usedMatchIds.has(l.matchId))
    .filter((l) => l.probability >= opts.minLegProb)
    .sort((a, b) => {
      // Primary: odds descending (higher odds first → reach target faster)
      if (Math.abs(b.odds - a.odds) > 0.01) return b.odds - a.odds;
      // Secondary: quality descending (when odds are similar, prefer stronger pick)
      return b.probability * b.confidence - a.probability * a.confidence;
    });

  if (eligible.length === 0) {
    return evaluateParlay([]);
  }

  const legs: ParlayLeg[] = [];
  const localUsed = new Set<string>(usedMatchIds);
  let currentOdds = 1.0;

  // Greedy: keep adding the best-quality leg until we cross lowerBound.
  // We do NOT skip low-odds legs (a 1.05 leg is fine if it's a strong pick)
  // — the loop naturally stops once cumulative odds hits the target.
  for (const leg of eligible) {
    if (legs.length >= maxLegs) break;
    if (localUsed.has(leg.matchId)) continue;

    // If adding this leg would overshoot upperBound by too much AND we
    // already have minLegs, skip it (try to land closer to target).
    // But if we haven't hit minLegs yet, add it anyway — we need at least 2.
    const projectedOdds = currentOdds * leg.odds;
    if (legs.length >= minLegs && projectedOdds > upperBound) {
      // Skip this leg — it'd push us past the target range.
      // Look for a leg with lower odds that keeps us in range.
      continue;
    }

    legs.push(leg);
    localUsed.add(leg.matchId);
    currentOdds = projectedOdds;

    // Stop once we've crossed the lower bound and have at least minLegs.
    if (legs.length >= minLegs && currentOdds >= lowerBound) break;
  }

  // If we never hit the lower bound (rare — thin day with few eligible legs),
  // accept whatever we have. The UI will show the actual combined odds.
  if (legs.length === 0) return evaluateParlay([]);

  return evaluateParlay(legs);
}

/**
 * Main entry — builds and persists all parlay tiers for a date.
 */
export async function buildAndPersistParlays(dateStr: string): Promise<{
  safest: ParlayCandidate | null;
  mediumRisk: ParlayCandidate | null;
  highRisk: ParlayCandidate | null;
  megaOdds: ParlayCandidate | null;
  odds3A: ParlayCandidate | null;
  odds3B: ParlayCandidate | null;
  odds5A: ParlayCandidate | null;
  odds5B: ParlayCandidate | null;
}> {
  // Load all predictions for date
  const matches = await db.match.findMany({
    where: { matchDate: dateStr },
    include: {
      predictions: true,
    },
  });

  const allLegs: ParlayLeg[] = [];
  // Track per-prediction source info for ML scoring (sourcesJson → source names
  // → SourceMLInfo lookup). We need this to compute weighted Platt-calibrated
  // probabilities per leg.
  const legSourceInfoMap = new Map<string, { sources: LegInput["sources"]; leagueId: string | null; market: string; disagreement: number | null; consensusSources: number }>();

  for (const m of matches) {
    for (const p of m.predictions) {
      // Skip bet_builder markets — they're already composites
      if (p.market === "bet_builder") continue;
      allLegs.push({
        predictionId: p.id,
        matchId: m.id,
        matchLabel: `${m.homeTeam} v ${m.awayTeam}`,
        market: p.market,
        selection: p.selection,
        odds: p.bookOdds ?? p.fairOdds,
        probability: p.probability,
        confidence: p.confidence,
        // ── B4: Correlation inputs ─────────────────────────────────────────
        leagueId: m.leagueId ?? null,
        kickoffUtc: m.kickoffUtc,
        // ── B3: For consensus requirement (stored on the prediction row) ────
        // We attach consensusSources via a side channel so the greedy builder
        // can filter on it. The ParlayLeg type doesn't include it, but
        // buildGreedyParlay accesses it via cast.
        ...({ consensusSources: p.consensusSources ?? 0 } as object),
      });

      // Parse sourcesJson to extract per-source probabilities for ML scoring.
      // sourcesJson format: [{ source: "espn", probability: 0.65, ... }, ...]
      const sources: LegInput["sources"] = [];
      try {
        const srcArr = JSON.parse(p.sourcesJson ?? "[]") as Array<{ source?: string; probability?: number }>;
        // We need SourceMLInfo to look up weight, brier, etc. We'll do that
        // in a second pass after loading all sources from DB. For now, just
        // record the source names + raw probabilities.
        for (const s of srcArr) {
          if (s.source && typeof s.probability === "number" && s.probability > 0 && s.probability < 1) {
            sources.push({
              sourceId: s.source, // temporary — will be replaced with real sourceId
              weight: 0.5,
              brier30d: 0.25,
              clv30d: 0,
              calibrationA: 1,
              calibrationB: 0,
              rawProb: s.probability,
            });
          }
        }
      } catch { /* sourcesJson parse failure — leg will be unscored */ }

      legSourceInfoMap.set(p.id, {
        sources,
        leagueId: m.leagueId ?? null,
        market: p.market,
        disagreement: p.disagreement,
        consensusSources: p.consensusSources ?? 0,
      });
    }
  }

  if (allLegs.length === 0) {
    return {
      safest: null, mediumRisk: null, highRisk: null, megaOdds: null,
      odds3A: null, odds3B: null, odds5A: null, odds5B: null,
    };
  }

  // ── ML scoring pass ─────────────────────────────────────────────────────
  // 1. Load all sources from DB (one query) so we can look up weight, brier,
  //    clv, and Platt params per source name.
  // 2. Load all parlay-tier stats (one query) so each tier's Bayesian prior
  //    is available.
  // 3. Load all market-league CLV rows (one query).
  // 4. For each leg, compute its ML score using its tier's historical win
  //    rate. (Since a leg could appear in any tier, we compute the score
  //    against a "neutral" tier — the safest tier's stats — and let the
  //    per-tier builders re-rank as needed.)
  const sourceMLMap = await loadSourceMLInfo();
  const tierStatsMap = await loadAllParlayTierStats();
  const marketClvMap = await loadMarketLeagueClvMap();

  // Enrich the leg source info with real source weights/Brier/CLV/Platt.
  for (const [, info] of legSourceInfoMap.entries()) {
    for (const s of info.sources) {
      const srcInfo = sourceMLMap.get(s.sourceId);
      if (srcInfo) {
        s.sourceId = srcInfo.sourceId;
        s.weight = srcInfo.weight;
        s.brier30d = srcInfo.brier30d;
        s.clv30d = srcInfo.clv30d;
        s.calibrationA = srcInfo.calibrationA;
        s.calibrationB = srcInfo.calibrationB;
      }
    }
  }

  // Compute ML scores for every leg, using the "safest" tier's stats as the
  // reference (it has the most samples in practice). Per-tier re-ranking is
  // done inside the builders via the legMLMap.
  const safestStats = tierStatsMap.get("safest") ?? {
    tier: "safest", totalParlays: 0, wonParlays: 0, totalLegs: 0, wonLegs: 0,
    rollingWinRate: 0, lifetimeWinRate: 0, sampleCount: 0,
  };
  const tierWinRate = safestStats.sampleCount > 0
    ? (safestStats.rollingWinRate > 0 ? safestStats.rollingWinRate : safestStats.lifetimeWinRate)
    : 0.5;
  const tierSampleCount = safestStats.sampleCount;

  const legMLMap = new Map<string, LegMLScore>();
  for (const leg of allLegs) {
    const info = legSourceInfoMap.get(leg.predictionId);
    if (!info) continue;
    const marketClv = info.leagueId
      ? (marketClvMap.get(`${info.market}|${info.leagueId}`) ?? null)
      : null;
    const legInput: LegInput = {
      predictionId: leg.predictionId,
      matchId: leg.matchId,
      matchLabel: leg.matchLabel,
      market: leg.market,
      selection: leg.selection,
      odds: leg.odds,
      probability: leg.probability,
      confidence: leg.confidence,
      consensusSources: info.consensusSources,
      disagreement: info.disagreement,
      sources: info.sources,
      leagueId: info.leagueId,
      marketLeagueClv: marketClv,
    };
    const mlScore = computeLegMLScore(legInput, tierWinRate, tierSampleCount);
    legMLMap.set(leg.predictionId, mlScore);
  }

  // ── No-overlap rule: each match appears in at most ONE parlay tier ─────────
  // Build order matters: safest goes first (strictest requirements, needs the
  // best high-prob legs), then medium, then high, then mega. Each tier claims
  // its matchIds and the next tier only sees the remaining pool.
  // If a tier would starve (empty) because all its eligible matches are already
  // claimed, that's fine — we'd rather have an empty tier than a duplicate leg.
  //
  // ── ML-driven leg selection (B7) ─────────────────────────────────────────
  // Each tier now uses `buildGreedyParlayML` / `buildTargetOddsParlayML` which
  // rank legs by their ML reliability score (calibrated prob + consensus +
  // low disagreement + market CLV + source Brier/CLV + tier history) instead
  // of the naive `prob × confidence` ranking. Min-reliability thresholds are
  // set per tier so the safest tier only uses A-grade legs (≥0.70), medium
  // uses B-grade (≥0.55), and high-risk / mega allow speculative legs.
  const usedMatchIds = new Set<string>();

  const safest = buildGreedyParlayML(
    allLegs,
    legMLMap,
    {
      maxLegs: 3,
      minLegProb: ENGINE_CONFIG.SAFEST_MIN_LEG_PROB,
      minCombinedProb: 0.35,
      minConsensus: ENGINE_CONFIG.SAFEST_MIN_LEG_SOURCES,
      minReliability: 0.70, // A-grade legs only for the safest tier
    }
  );
  for (const leg of safest.legs) usedMatchIds.add(leg.matchId);

  const mediumRisk = buildGreedyParlayML(
    allLegs.filter((l) => !usedMatchIds.has(l.matchId)),
    legMLMap,
    { maxLegs: 4, minLegProb: 0.55, minCombinedProb: 0.08, minReliability: 0.55 }
  );
  for (const leg of mediumRisk.legs) usedMatchIds.add(leg.matchId);

  const highRisk = buildGreedyParlayML(
    allLegs.filter((l) => !usedMatchIds.has(l.matchId)),
    legMLMap,
    { maxLegs: 5, minLegProb: 0.40, minCombinedProb: 0.015, minReliability: 0.40 }
  );
  for (const leg of highRisk.legs) usedMatchIds.add(leg.matchId);

  // Mega-odds keeps its existing builder — it's about lottery-style payouts,
  // not safety, so ML scoring doesn't change which longshots we pick.
  const megaOdds = buildMegaOddsParlay(
    allLegs.filter((l) => !usedMatchIds.has(l.matchId))
  );
  for (const leg of megaOdds.legs) usedMatchIds.add(leg.matchId);

  // ── B6: Target-odds parlays (user request) — now ML-driven ────────────────
  // Two parlays targeting combined odds of ~3.0, two targeting ~5.0.
  // Leg count doesn't matter — only that each leg is a high-probability pick
  // (≥0.70 for odds_3, ≥0.60 for odds_5) AND ML reliability ≥ 0.65 / 0.55.
  // These respect the no-overlap rule: odds_3_a picks first, then odds_3_b
  // (excluding A's matches), then odds_5_a, then odds_5_b.
  const odds3A = buildTargetOddsParlayML(
    allLegs,
    legMLMap,
    { targetOdds: 3.0, tolerance: 0.25, minLegProb: 0.70, maxLegs: 6, minLegs: 2, minReliability: 0.65 },
    usedMatchIds
  );
  for (const leg of odds3A.legs) usedMatchIds.add(leg.matchId);

  const odds3B = buildTargetOddsParlayML(
    allLegs,
    legMLMap,
    { targetOdds: 3.0, tolerance: 0.25, minLegProb: 0.70, maxLegs: 6, minLegs: 2, minReliability: 0.65 },
    usedMatchIds
  );
  for (const leg of odds3B.legs) usedMatchIds.add(leg.matchId);

  const odds5A = buildTargetOddsParlayML(
    allLegs,
    legMLMap,
    { targetOdds: 5.0, tolerance: 0.25, minLegProb: 0.60, maxLegs: 7, minLegs: 2, minReliability: 0.55 },
    usedMatchIds
  );
  for (const leg of odds5A.legs) usedMatchIds.add(leg.matchId);

  const odds5B = buildTargetOddsParlayML(
    allLegs,
    legMLMap,
    { targetOdds: 5.0, tolerance: 0.25, minLegProb: 0.60, maxLegs: 7, minLegs: 2, minReliability: 0.55 },
    usedMatchIds
  );
  for (const leg of odds5B.legs) usedMatchIds.add(leg.matchId);

  // Clear existing parlays for this date (covers old "daily_best"/"safe"/"value" types too)
  await db.parlay.deleteMany({ where: { matchDate: dateStr } });

  // ── Helper: compute Kelly stake for a parlay using Bayesian-adjusted prob ──
  // For each tier, blend the ML-combined probability with the tier's historical
  // observed win rate. Cold start (0 samples) → use the math unchanged. Mature
  // tier (30+ samples) → ~75% weight on observed reality. The Kelly stake is
  // then computed against this Bayesian posterior instead of the raw combined
  // probability, so stakes shrink for tiers that systematically underperform
  // their theoretical probability and grow for tiers that outperform.
  const computeBayesianKelly = (
    cand: ParlayCandidate,
    tier: string
  ): { kelly: KellyResult; adjustedProb: number; sampleCount: number } => {
    if (cand.legs.length === 0) {
      return {
        kelly: { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false },
        adjustedProb: 0,
        sampleCount: 0,
      };
    }
    const stats = tierStatsMap.get(tier);
    const observedWinRate = stats && stats.sampleCount > 0
      ? (stats.rollingWinRate > 0 ? stats.rollingWinRate : stats.lifetimeWinRate)
      : 0;
    const observedCount = stats?.sampleCount ?? 0;
    const adjustedProb = bayesianCombinedProb(
      cand.combinedProbability,
      observedWinRate,
      observedCount
    );
    const kelly = kellyParlayStake(adjustedProb, cand.combinedOdds, cand.legs.length);
    return { kelly, adjustedProb, sampleCount: observedCount };
  };

  const safeBK = computeBayesianKelly(safest, "safest");
  const mediumBK = computeBayesianKelly(mediumRisk, "medium_risk");
  const highBK = computeBayesianKelly(highRisk, "high_risk");
  const megaBK = computeBayesianKelly(megaOdds, "mega_odds");
  const odds3ABK = computeBayesianKelly(odds3A, "odds_3_a");
  const odds3BBK = computeBayesianKelly(odds3B, "odds_3_b");
  const odds5ABK = computeBayesianKelly(odds5A, "odds_5_a");
  const odds5BBK = computeBayesianKelly(odds5B, "odds_5_b");

  const tiers: Array<{
    type: string;
    cand: ParlayCandidate;
    k: KellyResult;
    adjustedProb: number;
    sampleCount: number;
  }> = [
    { type: "safest", cand: safest, k: safeBK.kelly, adjustedProb: safeBK.adjustedProb, sampleCount: safeBK.sampleCount },
    { type: "medium_risk", cand: mediumRisk, k: mediumBK.kelly, adjustedProb: mediumBK.adjustedProb, sampleCount: mediumBK.sampleCount },
    { type: "high_risk", cand: highRisk, k: highBK.kelly, adjustedProb: highBK.adjustedProb, sampleCount: highBK.sampleCount },
    { type: "mega_odds", cand: megaOdds, k: megaBK.kelly, adjustedProb: megaBK.adjustedProb, sampleCount: megaBK.sampleCount },
    { type: "odds_3_a", cand: odds3A, k: odds3ABK.kelly, adjustedProb: odds3ABK.adjustedProb, sampleCount: odds3ABK.sampleCount },
    { type: "odds_3_b", cand: odds3B, k: odds3BBK.kelly, adjustedProb: odds3BBK.adjustedProb, sampleCount: odds3BBK.sampleCount },
    { type: "odds_5_a", cand: odds5A, k: odds5ABK.kelly, adjustedProb: odds5ABK.adjustedProb, sampleCount: odds5ABK.sampleCount },
    { type: "odds_5_b", cand: odds5B, k: odds5BBK.kelly, adjustedProb: odds5BBK.adjustedProb, sampleCount: odds5BBK.sampleCount },
  ];

  for (const tier of tiers) {
    if (tier.cand.legs.length === 0) continue;
    // Build the ML components JSON for UI display + audit. Each leg's
    // reliability + component breakdown is included so the UI can show
    // exactly why this leg was selected.
    const mlComponentsJson = tier.cand.legMLScores
      ? JSON.stringify({
          parlayMLScore: tier.cand.mlScore ?? null,
          bayesianAdjustedProb: tier.adjustedProb,
          sampleCount: tier.sampleCount,
          legs: tier.cand.legs.map((leg, i) => ({
            predictionId: leg.predictionId,
            matchLabel: leg.matchLabel,
            market: leg.market,
            selection: leg.selection,
            reliability: tier.cand.legMLScores![i]?.reliability ?? null,
            calibratedProb: tier.cand.legMLScores![i]?.calibratedProb ?? null,
            adjustedProb: tier.cand.legMLScores![i]?.adjustedProb ?? null,
            components: tier.cand.legMLScores![i]?.components ?? null,
          })),
        })
      : null;

    await db.parlay.create({
      data: {
        matchDate: dateStr,
        type: tier.type,
        legsJson: JSON.stringify(tier.cand.legs),
        legsCount: tier.cand.legs.length,
        combinedProbability: tier.cand.combinedProbability,
        combinedOdds: tier.cand.combinedOdds,
        confidence: tier.cand.confidence,
        expectedValue: tier.cand.expectedValue,
        kellyFraction: tier.k.fullKelly,
        recommendedStake: tier.k.recommendedStake,
        // ── ML fields ──────────────────────────────────────────────────────
        mlScore: tier.cand.mlScore ?? null,
        mlComponentsJson,
        mlAdjustedProbability: tier.adjustedProb,
        mlSampleCount: tier.sampleCount,
      },
    });
  }

  return { safest, mediumRisk, highRisk, megaOdds, odds3A, odds3B, odds5A, odds5B };
}
