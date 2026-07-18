/**
 * Stake Ledger — tracks every stake recommendation from creation to settlement
 * ─────────────────────────────────────────────────────────────────────────────
 * Lifecycle:
 *
 *   recommended → placed → settled
 *                       ↘ void
 *   recommended → skipped (user opted not to bet)
 *
 * WHY THIS EXISTS:
 *   Without a ledger, we have Kelly stake RECOMMENDATIONS but no way to track
 *   whether they were PLACED, whether they WON, or how much was RETURNED. The
 *   ledger is the bridge between "the model said X" and "the user's actual
 *   bankroll moved by Y".
 *
 *   Each row carries:
 *     - recommendedStake: fraction of bankroll [0, 1] (from Kelly)
 *     - bankrollAtTime:   bankroll used to compute the monetary stake
 *     - stakeAmount:      recommendedStake × bankrollAtTime (monetary)
 *     - status:           recommended → placed → settled/void/skipped
 *     - actualReturn:     monetary units returned (0 if lost, stake × odds if won)
 *     - realizedRoi:      (actualReturn - stakeAmount) / stakeAmount
 *
 * WRITES:
 *   - `recordStakeRecommendations`: called after parlay build — inserts a row
 *     for every parlay with positive Kelly stake.
 *   - `markStakePlaced`: called when user marks a stake as actually placed.
 *   - `settleStakesForDate`: called by the feedback loop — settles all
 *     non-pending stakes for a given date by looking up match outcomes.
 *
 * READS:
 *   - `getStakeLedger`: query by date / tier / status.
 *   - `aggregateStakeLedger`: per-tier realized ROI (separate from theoretical).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "@/lib/db";

// ──────────────────────────────────────────────────────────────────────────────
// Write — record recommendations (called after parlay build)
// ──────────────────────────────────────────────────────────────────────────────

export interface StakeRecommendation {
  parlayId: string;
  pickAuditId?: string | null;
  matchDate: string;
  tier: string;
  recommendedStake: number; // fraction [0, 1]
  combinedOdds: number;
  drawdownState?: string | null;
  portfolioScale?: number | null;
}

/**
 * Record stake recommendations for a set of parlays.
 *
 * Called by `buildAndPersistParlays` after all 8 tiers are persisted. For
 * every parlay with positive Kelly stake, we insert a StakeLedger row with
 * status="recommended". The bankroll at recommendation time is captured so
 * we can reconstruct the monetary stake even if the bankroll changes later.
 *
 * Idempotent at the (matchDate, parlayId) level — if a stake row already
 * exists for this parlayId, we skip it. (Pipeline re-runs produce new
 * parlayIds because the Parlay table is wiped + recreated.)
 */
export async function recordStakeRecommendations(
  recommendations: StakeRecommendation[],
  bankrollAtTime: number
): Promise<void> {
  if (recommendations.length === 0) return;

  // Filter out zero-stake recommendations — they don't generate ledger rows.
  const positive = recommendations.filter((r) => r.recommendedStake > 0);
  if (positive.length === 0) return;

  // Bulk-check existing parlayIds to skip duplicates (idempotency)
  const parlayIds = positive.map((r) => r.parlayId);
  const existing = await db.stakeLedger.findMany({
    where: { parlayId: { in: parlayIds } },
    select: { parlayId: true },
  });
  const existingSet = new Set(existing.map((e) => e.parlayId));

  const toCreate = positive
    .filter((r) => !existingSet.has(r.parlayId))
    .map((r) => ({
      parlayId: r.parlayId,
      pickAuditId: r.pickAuditId ?? null,
      matchDate: r.matchDate,
      tier: r.tier,
      recommendedStake: r.recommendedStake,
      bankrollAtTime,
      stakeAmount: r.recommendedStake * bankrollAtTime,
      combinedOdds: r.combinedOdds,
      status: "recommended" as const,
      drawdownState: r.drawdownState ?? null,
      portfolioScale: r.portfolioScale ?? null,
    }));

  if (toCreate.length === 0) return;

  await db.stakeLedger.createMany({ data: toCreate });
}

// ──────────────────────────────────────────────────────────────────────────────
// Write — mark as placed (user accepted the recommendation)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Mark a stake as actually placed by the user.
 *
 * This is the manual bridge between "the model recommended" and "I actually
 * bet this at a sportsbook". Until a stake is marked placed, we treat it as
 * a recommendation only — it doesn't count against the bankroll snapshot's
 * "totalStaked" until the user confirms placement.
 *
 * In an automated/trust-the-model deployment, the feedback loop can mark all
 * recommended stakes as placed automatically before settlement.
 */
export async function markStakePlaced(
  parlayId: string,
  opts?: { actualStakeAmount?: number; notes?: string }
): Promise<void> {
  await db.stakeLedger.updateMany({
    where: { parlayId, status: "recommended" },
    data: {
      status: "placed",
      placedAt: new Date(),
      ...(opts?.actualStakeAmount !== undefined && { stakeAmount: opts.actualStakeAmount }),
      ...(opts?.notes && { notes: opts.notes }),
    },
  });
}

/**
 * Mark a stake as skipped — the user explicitly chose not to place it.
 * Recorded for compliance audit (so we can explain why a recommendation
 * wasn't acted on).
 */
export async function markStakeSkipped(parlayId: string, reason?: string): Promise<void> {
  await db.stakeLedger.updateMany({
    where: { parlayId, status: "recommended" },
    data: {
      status: "skipped",
      notes: reason ?? null,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Write — settle (called by feedback loop after matches finish)
// ──────────────────────────────────────────────────────────────────────────────

export interface SettlementOutcome {
  parlayId: string;
  won: boolean;
  legsWon: number;
  legsLost: number;
  legsVoid: number;
}

/**
 * Settle all pending stakes for a given date.
 *
 * Called by the feedback loop after all matches for a date have finished and
 * parlay outcomes have been computed. For every "placed" or "recommended"
 * StakeLedger row for `dateStr`, we look up the parlay's settlement outcome
 * (from the Parlay table) and update the stake row with the actual return.
 *
 * Settlement rules:
 *   - WON:  actualReturn = stakeAmount × combinedOdds, realizedRoi = +odds-1
 *   - LOST: actualReturn = 0, realizedRoi = -1 (lost entire stake)
 *   - VOID: actualReturn = stakeAmount (refunded), realizedRoi = 0
 *
 * Also marks the corresponding PickAudit row as settled (via settlePickAudit).
 */
export async function settleStakesForDate(
  dateStr: string,
  outcomes: SettlementOutcome[]
): Promise<void> {
  if (outcomes.length === 0) return;

  // Build a lookup of parlayId → outcome for efficient updates
  const outcomeMap = new Map(outcomes.map((o) => [o.parlayId, o]));

  // Load all pending stakes for this date
  const pending = await db.stakeLedger.findMany({
    where: {
      matchDate: dateStr,
      status: { in: ["recommended", "placed"] },
    },
  });

  for (const stake of pending) {
    const outcome = outcomeMap.get(stake.parlayId);
    if (!outcome) continue; // parlay outcome not yet computed — skip

    let actualReturn: number;
    let realizedRoi: number;
    let status: "settled" | "void";

    if (outcome.legsVoid > 0 && outcome.legsWon === 0 && outcome.legsLost === 0) {
      // Entire parlay voided (e.g. all matches postponed)
      actualReturn = stake.stakeAmount;
      realizedRoi = 0;
      status = "void";
    } else if (outcome.won) {
      actualReturn = stake.stakeAmount * stake.combinedOdds;
      realizedRoi = (actualReturn - stake.stakeAmount) / stake.stakeAmount;
      status = "settled";
    } else {
      actualReturn = 0;
      realizedRoi = -1;
      status = "settled";
    }

    await db.stakeLedger.update({
      where: { id: stake.id },
      data: {
        status,
        settledAt: new Date(),
        won: outcome.won,
        actualReturn,
        realizedRoi,
      },
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Read — for API endpoints and post-mortem
// ──────────────────────────────────────────────────────────────────────────────

export interface StakeLedgerRow {
  id: string;
  parlayId: string;
  matchDate: string;
  tier: string;
  recommendedStake: number;
  bankrollAtTime: number;
  stakeAmount: number;
  combinedOdds: number;
  status: string;
  placedAt: Date | null;
  settledAt: Date | null;
  won: boolean | null;
  actualReturn: number | null;
  realizedRoi: number | null;
  drawdownState: string | null;
  portfolioScale: number | null;
  createdAt: Date;
}

export async function getStakeLedger(opts: {
  matchDate?: string;
  startDate?: string;
  endDate?: string;
  tier?: string;
  status?: string;
  limit?: number;
}): Promise<StakeLedgerRow[]> {
  const where: Record<string, unknown> = {};
  if (opts.matchDate) where.matchDate = opts.matchDate;
  if (opts.startDate || opts.endDate) {
    where.matchDate = {};
    if (opts.startDate) (where.matchDate as { gte?: string }).gte = opts.startDate;
    if (opts.endDate) (where.matchDate as { lte?: string }).lte = opts.endDate;
  }
  if (opts.tier) where.tier = opts.tier;
  if (opts.status) where.status = opts.status;

  const rows = await db.stakeLedger.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 100,
  });

  return rows.map((r) => ({
    id: r.id,
    parlayId: r.parlayId,
    matchDate: r.matchDate,
    tier: r.tier,
    recommendedStake: r.recommendedStake,
    bankrollAtTime: r.bankrollAtTime,
    stakeAmount: r.stakeAmount,
    combinedOdds: r.combinedOdds,
    status: r.status,
    placedAt: r.placedAt,
    settledAt: r.settledAt,
    won: r.won,
    actualReturn: r.actualReturn,
    realizedRoi: r.realizedRoi,
    drawdownState: r.drawdownState,
    portfolioScale: r.portfolioScale,
    createdAt: r.createdAt,
  }));
}

/**
 * Aggregate realized performance per tier from settled stake ledger rows.
 *
 * Different from `aggregatePickAuditByTier` — this uses ACTUAL stake amounts
 * and ACTUAL returns, so it reflects real money P&L (not just theoretical
 * pick accuracy). Use this for "did we make or lose money?" reporting.
 */
export async function aggregateStakeLedgerByTier(opts: {
  startDate?: string;
  endDate?: string;
}): Promise<Array<{
  tier: string;
  totalStakes: number;
  settledStakes: number;
  wonStakes: number;
  lostStakes: number;
  voidStakes: number;
  winRate: number;
  totalStaked: number;
  totalReturned: number;
  totalProfit: number;
  realizedRoi: number; // totalProfit / totalStaked
  meanRecommendedStake: number;
}>> {
  const where: Record<string, unknown> = { status: "settled" };
  if (opts.startDate || opts.endDate) {
    where.matchDate = {};
    if (opts.startDate) (where.matchDate as { gte?: string }).gte = opts.startDate;
    if (opts.endDate) (where.matchDate as { lte?: string }).lte = opts.endDate;
  }

  const rows = await db.stakeLedger.findMany({
    where,
    select: {
      tier: true,
      won: true,
      stakeAmount: true,
      actualReturn: true,
      recommendedStake: true,
    },
  });

  const byTier = new Map<string, {
    total: number;
    won: number;
    lost: number;
    void: number;
    staked: number;
    returned: number;
    recommendedSum: number;
  }>();

  for (const r of rows) {
    let bucket = byTier.get(r.tier);
    if (!bucket) {
      bucket = { total: 0, won: 0, lost: 0, void: 0, staked: 0, returned: 0, recommendedSum: 0 };
      byTier.set(r.tier, bucket);
    }
    bucket.total++;
    if (r.won === true) bucket.won++;
    else if (r.won === false) bucket.lost++;
    else bucket.void++;
    bucket.staked += r.stakeAmount;
    bucket.returned += r.actualReturn ?? 0;
    bucket.recommendedSum += r.recommendedStake;
  }

  return Array.from(byTier.entries()).map(([tier, b]) => {
    const winRate = b.won + b.lost > 0 ? b.won / (b.won + b.lost) : 0;
    const profit = b.returned - b.staked;
    return {
      tier,
      totalStakes: b.total,
      settledStakes: b.won + b.lost,
      wonStakes: b.won,
      lostStakes: b.lost,
      voidStakes: b.void,
      winRate,
      totalStaked: b.staked,
      totalReturned: b.returned,
      totalProfit: profit,
      realizedRoi: b.staked > 0 ? profit / b.staked : 0,
      meanRecommendedStake: b.total > 0 ? b.recommendedSum / b.total : 0,
    };
  }).sort((a, b) => a.tier.localeCompare(b.tier));
}
