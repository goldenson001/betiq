/**
 * Confidence Engine
 * ──────────────────
 * Takes the engine's per-match predictions and:
 *   1. Surfaces the best daily parlay (accumulator)
 *   2. Surfaces best value bets (positive edge, reasonable probability)
 *   3. Surfaces a "safe" parlay (high-probability legs)
 *   4. Persists parlays to DB
 */

import { db } from "@/lib/db";

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
 * Builds the best daily parlay using a greedy algorithm:
 * Start with the highest-confidence top pick, add legs that maximize EV
 * while keeping combined probability above a floor (0.04 = ~25/1 max odds).
 */
function buildBestParlay(allLegs: ParlayLeg[], maxLegs: number = 5): ParlayCandidate {
  // Sort by confidence * probability (we want strong picks, not longshots)
  const sorted = [...allLegs].sort(
    (a, b) => b.probability * b.confidence - a.probability * a.confidence
  );
  if (sorted.length === 0) {
    return evaluateParlay([]);
  }

  // Start with top 1
  const legs: ParlayLeg[] = [sorted[0]];
  const used = new Set<string>([sorted[0].matchId]);

  while (legs.length < maxLegs) {
    let bestGain = -Infinity;
    let bestLeg: ParlayLeg | null = null;
    for (const leg of sorted) {
      if (used.has(leg.matchId)) continue;
      const trial = [...legs, leg];
      const cand = evaluateParlay(trial);
      if (cand.combinedProbability < 0.04) continue;
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
 * Builds a "safe" parlay: legs with probability >= 0.7 only, capped at 4 legs.
 */
function buildSafeParlay(allLegs: ParlayLeg[]): ParlayCandidate {
  const safeLegs = allLegs
    .filter((l) => l.probability >= 0.7)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 4);
  // Dedupe by match
  const seen = new Set<string>();
  const deduped = safeLegs.filter((l) => {
    if (seen.has(l.matchId)) return false;
    seen.add(l.matchId);
    return true;
  });
  return evaluateParlay(deduped);
}

/**
 * Finds the top N value bets — highest positive edge with prob in [0.35, 0.80].
 */
function findValueBets(allLegs: ParlayLeg[], topN: number = 10): ParlayLeg[] {
  return allLegs
    .filter((l) => l.odds * l.probability - 1 > 0.02)
    .filter((l) => l.probability >= 0.3 && l.probability <= 0.85)
    .sort((a, b) => {
      const evA = a.odds * a.probability - 1;
      const evB = b.odds * b.probability - 1;
      return evB - evA;
    })
    .slice(0, topN);
}

/**
 * Main entry — builds and persists all parlay types for a date.
 */
export async function buildAndPersistParlays(dateStr: string): Promise<{
  bestParlay: ParlayCandidate | null;
  safeParlay: ParlayCandidate | null;
  valueBets: ParlayLeg[];
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
    return { bestParlay: null, safeParlay: null, valueBets: [] };
  }

  const bestParlay = buildBestParlay(allLegs, 5);
  const safeParlay = buildSafeParlay(allLegs);
  const valueBets = findValueBets(allLegs, 10);

  // Clear existing parlays for this date
  await db.parlay.deleteMany({ where: { matchDate: dateStr } });

  // Persist best parlay
  if (bestParlay.legs.length > 0) {
    await db.parlay.create({
      data: {
        matchDate: dateStr,
        type: "daily_best",
        legsJson: JSON.stringify(bestParlay.legs),
        legsCount: bestParlay.legs.length,
        combinedProbability: bestParlay.combinedProbability,
        combinedOdds: bestParlay.combinedOdds,
        confidence: bestParlay.confidence,
        expectedValue: bestParlay.expectedValue,
      },
    });
  }

  // Persist safe parlay
  if (safeParlay.legs.length > 0) {
    await db.parlay.create({
      data: {
        matchDate: dateStr,
        type: "safe",
        legsJson: JSON.stringify(safeParlay.legs),
        legsCount: safeParlay.legs.length,
        combinedProbability: safeParlay.combinedProbability,
        combinedOdds: safeParlay.combinedOdds,
        confidence: safeParlay.confidence,
        expectedValue: safeParlay.expectedValue,
      },
    });
  }

  // Persist value-bet parlay (top 3 value bets)
  if (valueBets.length > 0) {
    const valueParlay = evaluateParlay(valueBets.slice(0, 3));
    await db.parlay.create({
      data: {
        matchDate: dateStr,
        type: "value",
        legsJson: JSON.stringify(valueBets),
        legsCount: valueBets.length,
        combinedProbability: valueParlay.combinedProbability,
        combinedOdds: valueParlay.combinedOdds,
        confidence: valueParlay.confidence,
        expectedValue: valueParlay.expectedValue,
      },
    });
  }

  return { bestParlay, safeParlay, valueBets };
}
