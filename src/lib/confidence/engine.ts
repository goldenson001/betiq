/**
 * Confidence Engine
 * ──────────────────
 * Takes the engine's per-match predictions and builds FOUR daily parlay tiers
 * calibrated for different risk appetites:
 *
 *   1. safest      — 2-3 legs, each leg probability >= 0.75. Target: ~70-85%
 *                    combined win probability. For investors who want high
 *                    win-rate, low-variance returns.
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
 * Persists all four parlays to DB. Idempotent: clears existing parlays for
 * the date before re-creating.
 */

import { db } from "@/lib/db";
import { kellyParlay as kellyParlayStake, type KellyResult } from "@/lib/learning/kelly";

interface ParlayLeg {
  predictionId: string;
  matchId: string;
  matchLabel: string;
  market: string;
  selection: string;
  odds: number;
  probability: number;
  confidence: number;
}

interface ParlayCandidate {
  legs: ParlayLeg[];
  combinedProbability: number;
  combinedOdds: number;
  confidence: number; // 0-100
  expectedValue: number;
}

function evaluateParlay(legs: ParlayLeg[]): ParlayCandidate {
  const combinedProbability = legs.reduce((p, l) => p * l.probability, 1);
  const combinedOdds = legs.reduce((o, l) => o * l.odds, 1);
  const expectedValue = combinedOdds * combinedProbability - 1;
  // Confidence for parlays is a blend: combined probability * sqrt(num legs)
  // (so a 4-leg parlay with 0.7 each leg doesn't get a tiny confidence score)
  const numLegsFactor = Math.sqrt(legs.length);
  const rawConfidence = combinedProbability * numLegsFactor * 0.6 + Math.min(0.4, expectedValue + 0.5);
  const confidence = Math.max(5, Math.min(95, Math.round(rawConfidence * 100)));
  return { legs, combinedProbability, combinedOdds, confidence, expectedValue };
}

/**
 * Generic greedy parlay builder. Starts with the highest-quality leg and
 * adds legs that maximize expected value while keeping each leg's probability
 * above `minLegProb` AND keeping combined probability above `minCombinedProb`.
 *
 * Excludes combo / synthetic markets (bet_builder, win_btts, correct_score)
 * since these overlap with base markets and would double-count signal.
 */
function buildGreedyParlay(
  allLegs: ParlayLeg[],
  opts: {
    maxLegs: number;
    minLegProb: number;
    minCombinedProb: number;
  }
): ParlayCandidate {
  const EXCLUDED = new Set(["bet_builder", "win_btts", "correct_score", "htft"]);
  const eligible = allLegs
    .filter((l) => !EXCLUDED.has(l.market))
    .filter((l) => l.probability >= opts.minLegProb)
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
 * Mega-odds builder — targets combined odds >= 20/1 by including lower-probability
 * legs. Inverted greedy: prefer legs with probability in [0.15, 0.40] (longshots
 * but not pure luck), then keep adding until combined odds >= 20 OR maxLegs reached.
 */
function buildMegaOddsParlay(allLegs: ParlayLeg[]): ParlayCandidate {
  const EXCLUDED = new Set(["bet_builder", "win_btts", "correct_score", "htft"]);
  const eligible = allLegs
    .filter((l) => !EXCLUDED.has(l.market))
    .filter((l) => l.probability >= 0.15 && l.probability <= 0.50)
    .sort((a, b) => b.odds - a.odds); // highest odds first
  if (eligible.length === 0) {
    return evaluateParlay([]);
  }
  const legs: ParlayLeg[] = [];
  const used = new Set<string>();
  const TARGET_ODDS = 20.0;
  const MAX_LEGS = 6;
  for (const leg of eligible) {
    if (legs.length >= MAX_LEGS) break;
    if (used.has(leg.matchId)) continue;
    legs.push(leg);
    used.add(leg.matchId);
    const cand = evaluateParlay(legs);
    if (cand.combinedOdds >= TARGET_ODDS) break;
  }
  // If we couldn't hit the target with longshots, fall back to adding a
  // mid-probability leg to push the odds up
  if (legs.length < MAX_LEGS && evaluateParlay(legs).combinedOdds < TARGET_ODDS) {
    const mid = allLegs
      .filter((l) => !EXCLUDED.has(l.market))
      .filter((l) => l.probability >= 0.30 && l.probability <= 0.55)
      .filter((l) => !used.has(l.matchId))
      .sort((a, b) => b.odds - a.odds);
    for (const leg of mid) {
      if (legs.length >= MAX_LEGS) break;
      legs.push(leg);
      used.add(leg.matchId);
      if (evaluateParlay(legs).combinedOdds >= TARGET_ODDS) break;
    }
  }
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
      });
    }
  }

  if (allLegs.length === 0) {
    return { safest: null, mediumRisk: null, highRisk: null, megaOdds: null };
  }

  const safest = buildGreedyParlay(allLegs, { maxLegs: 3, minLegProb: 0.75, minCombinedProb: 0.35 });
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
