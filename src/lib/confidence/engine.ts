/**
 * Confidence Engine
 * ──────────────────
 * Takes the engine's per-match predictions and builds FOUR daily parlay tiers
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
 * Persists all four parlays to DB. Idempotent: clears existing parlays for
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

/**
 * Main entry — builds and persists all four parlay tiers for a date.
 */
export async function buildAndPersistParlays(dateStr: string): Promise<{
  safest: ParlayCandidate | null;
  mediumRisk: ParlayCandidate | null;
  highRisk: ParlayCandidate | null;
  megaOdds: ParlayCandidate | null;
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
    return { safest: null, mediumRisk: null, highRisk: null, megaOdds: null };
  }

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
  const mediumRisk = buildGreedyParlay(allLegs, { maxLegs: 4, minLegProb: 0.55, minCombinedProb: 0.08 });
  const highRisk = buildGreedyParlay(allLegs, { maxLegs: 5, minLegProb: 0.40, minCombinedProb: 0.015 });
  const megaOdds = buildMegaOddsParlay(allLegs);

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

  const tiers: Array<{
    type: string;
    cand: ParlayCandidate;
    k: KellyResult;
  }> = [
    { type: "safest", cand: safest, k: safeKelly },
    { type: "medium_risk", cand: mediumRisk, k: mediumKelly },
    { type: "high_risk", cand: highRisk, k: highKelly },
    { type: "mega_odds", cand: megaOdds, k: megaKelly },
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

  return { safest, mediumRisk, highRisk, megaOdds };
}
