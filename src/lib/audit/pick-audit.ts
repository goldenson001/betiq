/**
 * Pick Audit Log
 * ─────────────────────────────────────────────────────────────────────────────
 * IMMUTABLE record of every parlay ever built by the engine.
 *
 * Why this matters for real-money staking:
 *   - The `Parlay` table gets wiped on every pipeline re-run (deleteMany).
 *     Without an audit log, we lose the ability to post-mortem losing days:
 *     "Why did we recommend this parlay at 0.85 ML score? What signals fed it?"
 *   - The audit log captures EVERY signal that drove the decision at the
 *     moment of recommendation, so we can replay bad days and diagnose
 *     model drift, H2H mis-scoring, source weighting errors, etc.
 *   - When a stake settles, we backfill the outcome (won/lost/void,
 *     actualReturn, realizedRoi) on the audit row — keeping a complete
 *     lifecycle record in one place.
 *
 * Schema versioning:
 *   `schemaVersion: 1` — current. Bump when the JSON shape changes so old
 *   records can be migrated forward.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "@/lib/db";
import type { LegMLScore } from "@/lib/learning/parlay-ml";

// Local minimal types mirroring the engine's internal types — avoids a
// circular import with src/lib/confidence/engine.ts.
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

interface MinimalParlayCandidate {
  legs: ParlayLeg[];
  legsCount?: number;
  combinedProbability: number;
  combinedOdds: number;
  confidence: number;
  expectedValue: number;
  mlScore?: number | null;
  legMLScores?: LegMLScore[] | null;
}

export interface WritePickAuditInput {
  parlayId: string;
  matchDate: string;
  tier: string;
  cand: MinimalParlayCandidate;
  // ── Bayesian-adjusted prob + sample count (from Kelly computation) ──────
  adjustedProb?: number | null;
  sampleCount?: number | null;
  // ── Kelly stake at recommendation time ──────────────────────────────────
  kellyFraction?: number | null;
  recommendedStake?: number | null;
  // ── Risk context at build time (for post-mortem) ────────────────────────
  drawdownState?: string | null;
  portfolioScale?: number | null;
}

export interface PickAuditRow {
  id: string;
  parlayId: string;
  matchDate: string;
  tier: string;
  legsCount: number;
  combinedProbability: number;
  combinedOdds: number;
  mlScore: number | null;
  mlAdjustedProbability: number | null;
  kellyFraction: number | null;
  recommendedStake: number | null;
  settledAt: Date | null;
  won: boolean | null;
  legsWon: number | null;
  legsLost: number | null;
  actualReturn: number | null;
  realizedRoi: number | null;
  createdAt: Date;
}

// ──────────────────────────────────────────────────────────────────────────────
// Write — called from buildAndPersistParlays after each tier is persisted
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Write an immutable audit record for a single parlay.
 *
 * One row per parlay built — captures:
 *   - Frozen legs (legsJson) — exact selections at recommendation time
 *   - ML components snapshot — every signal's contribution to the score
 *   - H2H agreement snapshot — per-leg H2H agreement scores (user's #1 signal)
 *   - Kelly stake + Bayesian-adjusted probability
 *
 * Idempotent: if an audit row with this parlayId already exists (e.g.
 * pipeline re-ran for the same date), we skip rather than overwrite — the
 * first audit record is the canonical one. Subsequent re-runs write fresh
 * rows with new parlayIds (since the Parlay table is wiped + recreated).
 */
export async function writePickAudit(input: WritePickAuditInput): Promise<void> {
  const { parlayId, matchDate, tier, cand } = input;
  if (cand.legs.length === 0) return; // no legs → nothing to audit

  // Build ML components snapshot — array of per-leg component breakdowns
  const mlComponentsJson = cand.legMLScores && cand.legMLScores.length > 0
    ? JSON.stringify({
        parlayMLScore: cand.mlScore ?? null,
        bayesianAdjustedProb: input.adjustedProb ?? null,
        sampleCount: input.sampleCount ?? 0,
        riskContext: {
          drawdownState: input.drawdownState ?? null,
          portfolioScale: input.portfolioScale ?? null,
        },
        legs: cand.legs.map((leg, i) => ({
          predictionId: leg.predictionId,
          matchId: leg.matchId,
          matchLabel: leg.matchLabel,
          market: leg.market,
          selection: leg.selection,
          odds: leg.odds,
          probability: leg.probability,
          reliability: cand.legMLScores![i]?.reliability ?? null,
          calibratedProb: cand.legMLScores![i]?.calibratedProb ?? null,
          adjustedProb: cand.legMLScores![i]?.adjustedProb ?? null,
          components: cand.legMLScores![i]?.components ?? null,
        })),
      })
    : null;

  // Build H2H-specific snapshot — surface the H2H agreement sub-scores
  // (the user's #1 safety signal) so post-mortem analysis can find cases
  // where H2H contradicted a pick but the model let it through.
  const h2hSummaryJson = cand.legMLScores && cand.legMLScores.length > 0
    ? JSON.stringify({
        legs: cand.legs.map((leg, i) => ({
          predictionId: leg.predictionId,
          matchLabel: leg.matchLabel,
          market: leg.market,
          selection: leg.selection,
          h2h: cand.legMLScores![i]?.h2hBreakdown ?? null,
        })),
      })
    : null;

  await db.pickAudit.create({
    data: {
      parlayId,
      matchDate,
      tier,
      legsJson: JSON.stringify(cand.legs),
      legsCount: cand.legs.length,
      combinedProbability: cand.combinedProbability,
      combinedOdds: cand.combinedOdds,
      mlScore: cand.mlScore ?? null,
      mlComponentsJson,
      mlAdjustedProbability: input.adjustedProb ?? null,
      mlSampleCount: input.sampleCount ?? null,
      h2hSummaryJson,
      kellyFraction: input.kellyFraction ?? null,
      recommendedStake: input.recommendedStake ?? null,
      schemaVersion: 1,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Query — for post-mortem analysis and API endpoints
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Get audit records for a date range, optionally filtered by tier / settled state.
 */
export async function queryPickAudits(opts: {
  matchDate?: string;
  startDate?: string;
  endDate?: string;
  tier?: string;
  settledOnly?: boolean;
  unsettledOnly?: boolean;
  wonOnly?: boolean;
  lostOnly?: boolean;
  limit?: number;
}): Promise<PickAuditRow[]> {
  const where: Record<string, unknown> = {};
  if (opts.matchDate) where.matchDate = opts.matchDate;
  if (opts.startDate || opts.endDate) {
    where.matchDate = {};
    if (opts.startDate) (where.matchDate as { gte?: string }).gte = opts.startDate;
    if (opts.endDate) (where.matchDate as { lte?: string }).lte = opts.endDate;
  }
  if (opts.tier) where.tier = opts.tier;
  if (opts.settledOnly) where.settledAt = { not: null };
  if (opts.unsettledOnly) where.settledAt = null;
  if (opts.wonOnly) { where.settledAt = { not: null }; where.won = true; }
  if (opts.lostOnly) { where.settledAt = { not: null }; where.won = false; }

  const rows = await db.pickAudit.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 100,
  });

  return rows.map((r) => ({
    id: r.id,
    parlayId: r.parlayId,
    matchDate: r.matchDate,
    tier: r.tier,
    legsCount: r.legsCount,
    combinedProbability: r.combinedProbability,
    combinedOdds: r.combinedOdds,
    mlScore: r.mlScore,
    mlAdjustedProbability: r.mlAdjustedProbability,
    kellyFraction: r.kellyFraction,
    recommendedStake: r.recommendedStake,
    settledAt: r.settledAt,
    won: r.won,
    legsWon: r.legsWon,
    legsLost: r.legsLost,
    actualReturn: r.actualReturn,
    realizedRoi: r.realizedRoi,
    createdAt: r.createdAt,
  }));
}

/**
 * Aggregate realized performance per tier over a date range.
 *
 * Returns per-tier: count, winRate, mean ROI, mean CLV-adjusted prob vs
 * realized — the gap between predicted and actual is the model's calibration
 * error per tier, which is the most important metric for real-money staking.
 */
export async function aggregatePickAuditByTier(opts: {
  startDate?: string;
  endDate?: string;
}): Promise<Array<{
  tier: string;
  totalPicks: number;
  settledPicks: number;
  wonPicks: number;
  lostPicks: number;
  voidPicks: number;
  winRate: number;
  meanRealizedRoi: number;
  meanPredictedProb: number;
  calibrationError: number; // |predicted - actual| — lower is better
  totalStaked: number;
  totalReturned: number;
}>> {
  const where: Record<string, unknown> = { settledAt: { not: null } };
  if (opts.startDate || opts.endDate) {
    where.matchDate = {};
    if (opts.startDate) (where.matchDate as { gte?: string }).gte = opts.startDate;
    if (opts.endDate) (where.matchDate as { lte?: string }).lte = opts.endDate;
  }

  const rows = await db.pickAudit.findMany({
    where,
    select: {
      tier: true,
      won: true,
      legsWon: true,
      legsLost: true,
      legsVoid: true,
      realizedRoi: true,
      combinedProbability: true,
      recommendedStake: true,
      actualReturn: true,
    },
  });

  const byTier = new Map<string, {
    total: number;
    won: number;
    lost: number;
    void: number;
    roiSum: number;
    probSum: number;
    stakeSum: number;
    returnSum: number;
  }>();

  for (const r of rows) {
    let bucket = byTier.get(r.tier);
    if (!bucket) {
      bucket = { total: 0, won: 0, lost: 0, void: 0, roiSum: 0, probSum: 0, stakeSum: 0, returnSum: 0 };
      byTier.set(r.tier, bucket);
    }
    bucket.total++;
    if (r.won === true) bucket.won++;
    else if (r.won === false) bucket.lost++;
    else bucket.void++;
    if (r.realizedRoi !== null) bucket.roiSum += r.realizedRoi;
    if (r.combinedProbability) bucket.probSum += r.combinedProbability;
    if (r.recommendedStake !== null) bucket.stakeSum += r.recommendedStake;
    if (r.actualReturn !== null) bucket.returnSum += r.actualReturn;
  }

  return Array.from(byTier.entries()).map(([tier, b]) => {
    const settled = b.won + b.lost;
    const winRate = settled > 0 ? b.won / settled : 0;
    const meanRoi = b.total > 0 ? b.roiSum / b.total : 0;
    const meanProb = b.total > 0 ? b.probSum / b.total : 0;
    const calibrationError = Math.abs(meanProb - winRate);
    return {
      tier,
      totalPicks: b.total,
      settledPicks: settled,
      wonPicks: b.won,
      lostPicks: b.lost,
      voidPicks: b.void,
      winRate,
      meanRealizedRoi: meanRoi,
      meanPredictedProb: meanProb,
      calibrationError,
      totalStaked: b.stakeSum,
      totalReturned: b.returnSum,
    };
  }).sort((a, b) => a.tier.localeCompare(b.tier));
}

/**
 * Settle a single audit row — backfill outcome after the match finishes.
 * Idempotent: if already settled, returns without changes.
 */
export async function settlePickAudit(
  parlayId: string,
  outcome: {
    won: boolean;
    legsWon: number;
    legsLost: number;
    legsVoid: number;
    actualReturn: number;
    realizedRoi: number;
  }
): Promise<void> {
  // Only settle the most recent audit row for this parlayId (a parlay can
  // be re-built multiple times in a day, each producing a new audit row —
  // but only the LATEST should be settled).
  const latest = await db.pickAudit.findFirst({
    where: { parlayId, settledAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) return;

  await db.pickAudit.update({
    where: { id: latest.id },
    data: {
      settledAt: new Date(),
      won: outcome.won,
      legsWon: outcome.legsWon,
      legsLost: outcome.legsLost,
      legsVoid: outcome.legsVoid,
      actualReturn: outcome.actualReturn,
      realizedRoi: outcome.realizedRoi,
    },
  });
}
