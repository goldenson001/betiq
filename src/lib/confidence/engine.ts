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
    }
  }

  if (allLegs.length === 0) {
    return {
      safest: null, mediumRisk: null, highRisk: null, megaOdds: null,
      odds3A: null, odds3B: null, odds5A: null, odds5B: null,
    };
  }

  // ── No-overlap rule: each match appears in at most ONE parlay tier ─────────
  // Build order matters: safest goes first (strictest requirements, needs the
  // best high-prob legs), then medium, then high, then mega. Each tier claims
  // its matchIds and the next tier only sees the remaining pool.
  // If a tier would starve (empty) because all its eligible matches are already
  // claimed, that's fine — we'd rather have an empty tier than a duplicate leg.
  const usedMatchIds = new Set<string>();

  // B3: Tightened safest tier — minLegProb from SAFEST_MIN_LEG_PROB (default 0.80,
  // was 0.75), minConsensus from SAFEST_MIN_LEG_SOURCES (default 2, was 0).
  // This raises the safest-tier win rate to investment-grade (~50%+ combined prob
  // for 3 legs at 0.80³ = 0.51, vs old 0.75³ = 0.42).
  const safest = buildGreedyParlay(
    allLegs,
    {
      maxLegs: 3,
      minLegProb: ENGINE_CONFIG.SAFEST_MIN_LEG_PROB,
      minCombinedProb: 0.35,
      minConsensus: ENGINE_CONFIG.SAFEST_MIN_LEG_SOURCES,
    }
  );
  for (const leg of safest.legs) usedMatchIds.add(leg.matchId);

  const mediumRisk = buildGreedyParlay(
    allLegs.filter((l) => !usedMatchIds.has(l.matchId)),
    { maxLegs: 4, minLegProb: 0.55, minCombinedProb: 0.08 }
  );
  for (const leg of mediumRisk.legs) usedMatchIds.add(leg.matchId);

  const highRisk = buildGreedyParlay(
    allLegs.filter((l) => !usedMatchIds.has(l.matchId)),
    { maxLegs: 5, minLegProb: 0.40, minCombinedProb: 0.015 }
  );
  for (const leg of highRisk.legs) usedMatchIds.add(leg.matchId);

  const megaOdds = buildMegaOddsParlay(
    allLegs.filter((l) => !usedMatchIds.has(l.matchId))
  );
  for (const leg of megaOdds.legs) usedMatchIds.add(leg.matchId);

  // ── B6: Target-odds parlays (user request) ────────────────────────────────
  // Two parlays targeting combined odds of ~3.0, two targeting ~5.0.
  // Leg count doesn't matter — only that each leg is a high-probability pick
  // (≥0.70 for odds_3, ≥0.60 for odds_5) and the combined odds hits the target.
  // These respect the no-overlap rule: odds_3_a picks first, then odds_3_b
  // (excluding A's matches), then odds_5_a, then odds_5_b.
  const odds3A = buildTargetOddsParlay(
    allLegs,
    { targetOdds: 3.0, tolerance: 0.25, minLegProb: 0.70, maxLegs: 6, minLegs: 2 },
    usedMatchIds
  );
  for (const leg of odds3A.legs) usedMatchIds.add(leg.matchId);

  const odds3B = buildTargetOddsParlay(
    allLegs,
    { targetOdds: 3.0, tolerance: 0.25, minLegProb: 0.70, maxLegs: 6, minLegs: 2 },
    usedMatchIds
  );
  for (const leg of odds3B.legs) usedMatchIds.add(leg.matchId);

  const odds5A = buildTargetOddsParlay(
    allLegs,
    { targetOdds: 5.0, tolerance: 0.25, minLegProb: 0.60, maxLegs: 7, minLegs: 2 },
    usedMatchIds
  );
  for (const leg of odds5A.legs) usedMatchIds.add(leg.matchId);

  const odds5B = buildTargetOddsParlay(
    allLegs,
    { targetOdds: 5.0, tolerance: 0.25, minLegProb: 0.60, maxLegs: 7, minLegs: 2 },
    usedMatchIds
  );
  for (const leg of odds5B.legs) usedMatchIds.add(leg.matchId);

  // Clear existing parlays for this date (covers old "daily_best"/"safe"/"value" types too)
  await db.parlay.deleteMany({ where: { matchDate: dateStr } });

  // Compute Kelly stake for each parlay — fractional Kelly (1/8) with tighter
  // caps because parlay variance is much higher than single bets.
  const safeKelly: KellyResult = safest.legs.length > 0
    ? kellyParlayStake(safest.combinedProbability, safest.combinedOdds, safest.legs.length)
    : { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false };
  const mediumKelly: KellyResult = mediumRisk.legs.length > 0
    ? kellyParlayStake(mediumRisk.combinedProbability, mediumRisk.combinedOdds, mediumRisk.legs.length)
    : { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false };
  const highKelly: KellyResult = highRisk.legs.length > 0
    ? kellyParlayStake(highRisk.combinedProbability, highRisk.combinedOdds, highRisk.legs.length)
    : { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false };
  const megaKelly: KellyResult = megaOdds.legs.length > 0
    ? kellyParlayStake(megaOdds.combinedProbability, megaOdds.combinedOdds, megaOdds.legs.length)
    : { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false };
  const odds3AKelly: KellyResult = odds3A.legs.length > 0
    ? kellyParlayStake(odds3A.combinedProbability, odds3A.combinedOdds, odds3A.legs.length)
    : { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false };
  const odds3BKelly: KellyResult = odds3B.legs.length > 0
    ? kellyParlayStake(odds3B.combinedProbability, odds3B.combinedOdds, odds3B.legs.length)
    : { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false };
  const odds5AKelly: KellyResult = odds5A.legs.length > 0
    ? kellyParlayStake(odds5A.combinedProbability, odds5A.combinedOdds, odds5A.legs.length)
    : { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false };
  const odds5BKelly: KellyResult = odds5B.legs.length > 0
    ? kellyParlayStake(odds5B.combinedProbability, odds5B.combinedOdds, odds5B.legs.length)
    : { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false };

  const tiers: Array<{
    type: string;
    cand: ParlayCandidate;
    k: KellyResult;
  }> = [
    { type: "safest", cand: safest, k: safeKelly },
    { type: "medium_risk", cand: mediumRisk, k: mediumKelly },
    { type: "high_risk", cand: highRisk, k: highKelly },
    { type: "mega_odds", cand: megaOdds, k: megaKelly },
    { type: "odds_3_a", cand: odds3A, k: odds3AKelly },
    { type: "odds_3_b", cand: odds3B, k: odds3BKelly },
    { type: "odds_5_a", cand: odds5A, k: odds5AKelly },
    { type: "odds_5_b", cand: odds5B, k: odds5BKelly },
  ];

  for (const tier of tiers) {
    if (tier.cand.legs.length === 0) continue;
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
      },
    });
  }

  return { safest, mediumRisk, highRisk, megaOdds, odds3A, odds3B, odds5A, odds5B };
}
