/**
 * Bankroll State & Daily Snapshot
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks the user's bankroll over time and computes drawdown state.
 *
 * The bankroll module is the SINGLE SOURCE OF TRUTH for:
 *   - Current bankroll (used to compute monetary stakes from Kelly fractions)
 *   - Peak bankroll (for drawdown computation)
 *   - Drawdown state (normal / degraded / halted) — drives stake multipliers
 *   - Daily P&L (total staked, total returned, profit)
 *
 * CONFIG:
 *   The initial bankroll is configurable via `BANKROLL_INITIAL_UNITS` env var
 *   (default 1000 units). If a BankrollSnapshot already exists for any prior
 *   date, the most recent snapshot's `bankroll` is used as the current
 *   bankroll. Otherwise the initial value is used.
 *
 * DAILY SNAPSHOT:
 *   `snapshotBankroll(dateStr)` is called by the feedback loop after all of a
 *   day's matches have settled. It reads the day's settled stake ledger rows,
 *   computes P&L, updates the bankroll, and persists a BankrollSnapshot row.
 *
 * The snapshot is IDEMPOTENT — running it twice for the same date produces
 * the same result (it overwrites the existing row).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "@/lib/db";
import { ENGINE_CONFIG } from "@/lib/config";
import { computeDrawdownState, type DrawdownState } from "@/lib/learning/risk";

// ──────────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────────

const INITIAL_BANKROLL = Number(process.env.BANKROLL_INITIAL_UNITS ?? 1000);
const MAX_BANKROLL = 1_000_000_000; // sanity cap

// ──────────────────────────────────────────────────────────────────────────────
// Read — current state
// ──────────────────────────────────────────────────────────────────────────────

export interface BankrollState {
  bankroll: number;
  peakBankroll: number;
  drawdownPct: number; // 0..1 (1 = 100% loss)
  drawdownState: DrawdownState;
  /** Stake multiplier to apply to today's recommendations (1.0 / 0.5 / 0.0). */
  stakeMultiplier: number;
  /** Human-readable reason for the current state — surfaced in UI banner. */
  reason: string;
  winStreak: number;
  loseStreak: number;
  lastSnapshotDate: string | null;
}

/**
 * Get the current bankroll state, derived from the most recent snapshot.
 * If no snapshots exist, returns the initial state.
 *
 * This is what every stake-recommendation flow should call BEFORE computing
 * Kelly stakes — the stakeMultiplier is applied to every recommended stake.
 */
export async function getBankrollState(): Promise<BankrollState> {
  const latest = await db.bankrollSnapshot.findFirst({
    orderBy: { date: "desc" },
  });

  if (!latest) {
    return {
      bankroll: INITIAL_BANKROLL,
      peakBankroll: INITIAL_BANKROLL,
      drawdownPct: 0,
      drawdownState: "normal",
      stakeMultiplier: 1.0,
      reason: "Initial state — full Kelly stakes.",
      winStreak: 0,
      loseStreak: 0,
      lastSnapshotDate: null,
    };
  }

  const drawdownPct = latest.peakBankroll > 0
    ? Math.min(1, Math.max(0, (latest.peakBankroll - latest.bankroll) / latest.peakBankroll))
    : 0;

  // Re-derive the drawdown decision from the latest snapshot's context.
  // (We persist the decision so it's stable across reads within a day, but
  // we also recompute it here so the UI can show the "current" decision
  // even if more stakes have settled since the snapshot was written.)
  const decision = computeDrawdownState({
    loseStreak: latest.loseStreak,
    winStreak: latest.winStreak,
    peakRoi: 0, // not used — we use drawdownPct directly
    currentRoi: -drawdownPct, // negative because we're below peak
    previousState: latest.drawdownState as DrawdownState,
  });

  return {
    bankroll: latest.bankroll,
    peakBankroll: latest.peakBankroll,
    drawdownPct,
    drawdownState: decision.state,
    stakeMultiplier: decision.stakeMultiplier,
    reason: decision.reason,
    winStreak: latest.winStreak,
    loseStreak: latest.loseStreak,
    lastSnapshotDate: latest.date,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Write — daily snapshot
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot the bankroll for a given date.
 *
 * Reads all SETTLED StakeLedger rows for `dateStr`, computes the day's P&L,
 * updates the bankroll + peak + drawdown state, and upserts a
 * BankrollSnapshot row.
 *
 * Idempotent: re-running for the same date produces the same result.
 *
 * Called by the feedback loop after all matches for a date have settled.
 */
export async function snapshotBankroll(dateStr: string): Promise<BankrollState> {
  // ── Load prior snapshot (the day-before's bankroll is our starting point) ──
  const priorSnapshot = await db.bankrollSnapshot.findFirst({
    where: { date: { lt: dateStr } },
    orderBy: { date: "desc" },
  });

  const priorBankroll = priorSnapshot?.bankroll ?? INITIAL_BANKROLL;
  const priorPeak = priorSnapshot?.peakBankroll ?? INITIAL_BANKROLL;
  const priorWinStreak = priorSnapshot?.winStreak ?? 0;
  const priorLoseStreak = priorSnapshot?.loseStreak ?? 0;

  // ── Load today's settled stakes ──────────────────────────────────────────
  const settledStakes = await db.stakeLedger.findMany({
    where: {
      matchDate: dateStr,
      status: "settled",
    },
    select: {
      stakeAmount: true,
      actualReturn: true,
      won: true,
    },
  });

  const totalStaked = settledStakes.reduce((s, x) => s + x.stakeAmount, 0);
  const totalReturned = settledStakes.reduce((s, x) => s + (x.actualReturn ?? 0), 0);
  const totalProfit = totalReturned - totalStaked;
  const parlaysPlaced = settledStakes.length;
  const parlaysWon = settledStakes.filter((x) => x.won === true).length;
  const parlaysLost = settledStakes.filter((x) => x.won === false).length;

  // ── Compute new bankroll + peak + drawdown ───────────────────────────────
  const newBankroll = Math.max(0, Math.min(MAX_BANKROLL, priorBankroll + totalProfit));
  const newPeak = Math.max(priorPeak, newBankroll);
  const drawdownPct = newPeak > 0
    ? Math.min(1, Math.max(0, (newPeak - newBankroll) / newPeak))
    : 0;

  // ── Update streaks ───────────────────────────────────────────────────────
  // A day is a "win" if totalProfit > 0, "loss" if < 0, "neutral" if exactly 0.
  let winStreak = priorWinStreak;
  let loseStreak = priorLoseStreak;
  if (totalProfit > 0.001) {
    winStreak = priorWinStreak + 1;
    loseStreak = 0;
  } else if (totalProfit < -0.001) {
    loseStreak = priorLoseStreak + 1;
    winStreak = 0;
  }

  // ── Compute drawdown state transition ────────────────────────────────────
  const decision = computeDrawdownState({
    loseStreak,
    winStreak,
    peakRoi: 0,
    currentRoi: -drawdownPct,
    previousState: (priorSnapshot?.drawdownState ?? "normal") as DrawdownState,
  });

  // ── Count pending parlays (not yet settled) for this date ────────────────
  const parlaysPending = await db.stakeLedger.count({
    where: { matchDate: dateStr, status: { in: ["recommended", "placed"] } },
  });

  // ── Upsert snapshot ──────────────────────────────────────────────────────
  await db.bankrollSnapshot.upsert({
    where: { date: dateStr },
    create: {
      date: dateStr,
      bankroll: newBankroll,
      peakBankroll: newPeak,
      drawdownPct,
      drawdownState: decision.state,
      totalStaked,
      totalReturned,
      totalProfit,
      parlaysPlaced,
      parlaysWon,
      parlaysLost,
      parlaysPending,
      winStreak,
      loseStreak,
    },
    update: {
      bankroll: newBankroll,
      peakBankroll: newPeak,
      drawdownPct,
      drawdownState: decision.state,
      totalStaked,
      totalReturned,
      totalProfit,
      parlaysPlaced,
      parlaysWon,
      parlaysLost,
      parlaysPending,
      winStreak,
      loseStreak,
    },
  });

  return {
    bankroll: newBankroll,
    peakBankroll: newPeak,
    drawdownPct,
    drawdownState: decision.state,
    stakeMultiplier: decision.stakeMultiplier,
    reason: decision.reason,
    winStreak,
    loseStreak,
    lastSnapshotDate: dateStr,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Query — for API endpoints
// ──────────────────────────────────────────────────────────────────────────────

export interface BankrollHistoryRow {
  date: string;
  bankroll: number;
  peakBankroll: number;
  drawdownPct: number;
  drawdownState: DrawdownState;
  totalStaked: number;
  totalReturned: number;
  totalProfit: number;
  parlaysPlaced: number;
  parlaysWon: number;
  parlaysLost: number;
  winStreak: number;
  loseStreak: number;
}

export async function getBankrollHistory(opts: {
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<BankrollHistoryRow[]> {
  const where: Record<string, unknown> = {};
  if (opts.startDate || opts.endDate) {
    where.date = {};
    if (opts.startDate) (where.date as { gte?: string }).gte = opts.startDate;
    if (opts.endDate) (where.date as { lte?: string }).lte = opts.endDate;
  }
  const rows = await db.bankrollSnapshot.findMany({
    where,
    orderBy: { date: "desc" },
    take: opts.limit ?? 90,
  });
  return rows.map((r) => ({
    date: r.date,
    bankroll: r.bankroll,
    peakBankroll: r.peakBankroll,
    drawdownPct: r.drawdownPct,
    drawdownState: r.drawdownState as DrawdownState,
    totalStaked: r.totalStaked,
    totalReturned: r.totalReturned,
    totalProfit: r.totalProfit,
    parlaysPlaced: r.parlaysPlaced,
    parlaysWon: r.parlaysWon,
    parlaysLost: r.parlaysLost,
    winStreak: r.winStreak,
    loseStreak: r.loseStreak,
  }));
}
