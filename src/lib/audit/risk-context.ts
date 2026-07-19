/**
 * Risk Context Helpers
 * ─────────────────────
 * Computes the daily-loss context (B5) and data-quality context (B6) that
 * feed the risk gates in `confidence/engine.ts`.
 *
 * These helpers are isolated from the engine so they can be unit-tested and
 * reused by the /api/health endpoint for monitoring.
 */

import { db } from "@/lib/db";
import {
  computeDailyLossState,
  evaluateDataQuality,
  combineRiskStates,
  type DailyLossContext,
  type DailyLossDecision,
  type DataQualityContext,
  type DataQualityDecision,
  type DrawdownDecision,
} from "@/lib/learning/risk";

// ──────────────────────────────────────────────────────────────────────────────
// Daily-loss context (B5)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute today's realized loss as a fraction of bankroll.
 *
 * Reads the StakeLedger for parlays that settled TODAY (i.e. their settledAt
 * is within the current Brussels day) and sums their P&L.
 *
 * Returns:
 *   - todayLossFraction > 0 = net loss (bad)
 *   - todayLossFraction < 0 = net profit (good — no degradation needed)
 *   - atRiskFraction = sum of unsettled stakes still outstanding today
 *
 * If no bankroll snapshot exists, returns zeros (cold start, no losses yet).
 */
export async function computeDailyLossContext(
  dateStr: string,
  currentBankroll: number
): Promise<DailyLossContext> {
  if (currentBankroll <= 0) {
    return { todayLossFraction: 0, atRiskFraction: 0 };
  }

  // Settled TODAY = settledAt is within the current Brussels day.
  // We use the matchDate of the parlay (not settledAt) because the daily-loss
  // breaker should fire on the day the PARLAY was for, not the day it settled
  // (which can be the next day for late matches).
  const settledToday = await db.stakeLedger.findMany({
    where: {
      matchDate: dateStr,
      status: "settled",
    },
    select: { stakeAmount: true, actualReturn: true },
  });

  let totalStaked = 0;
  let totalReturned = 0;
  for (const row of settledToday) {
    totalStaked += row.stakeAmount;
    totalReturned += row.actualReturn ?? 0;
  }
  const netPnl = totalReturned - totalStaked; // positive = profit, negative = loss
  const todayLossFraction = netPnl < 0 ? -netPnl / currentBankroll : 0;

  // At-risk = unsettled stakes for today's parlays
  const atRisk = await db.stakeLedger.aggregate({
    where: { matchDate: dateStr, status: "recommended" },
    _sum: { stakeAmount: true },
  });
  const atRiskFraction = (atRisk._sum.stakeAmount ?? 0) / currentBankroll;

  return { todayLossFraction, atRiskFraction };
}

/**
 * Compute the daily-loss decision for the current state.
 *
 * Convenience wrapper that fetches the context from the DB and calls
 * `computeDailyLossState`.
 */
export async function getDailyLossDecision(
  dateStr: string,
  currentBankroll: number
): Promise<DailyLossDecision> {
  const ctx = await computeDailyLossContext(dateStr, currentBankroll);
  return computeDailyLossState(ctx);
}

// ──────────────────────────────────────────────────────────────────────────────
// Data-quality context (B6)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute the data-quality context for today's pipeline run.
 *
 * Reads ScrapeLog entries from the last 24h to compute:
 *   - scraperSuccessRate = successful scrapes / enabled sources
 *   - latestScrapeAgeHours = age of the most recent successful scrape
 *
 * Reads Match + Prediction rows for today to compute:
 *   - matchCoverage = matches with ≥1 prediction / total matches today
 *
 * If there are no enabled sources, returns a degenerate context that fails
 * all checks (no sources = no data = don't bet).
 */
export async function computeDataQualityContext(dateStr: string): Promise<DataQualityContext> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // ── Scraper success rate ──────────────────────────────────────────────
  // Count enabled sources (not "espn-results" which is a special live-score
  // scraper that runs separately from the prediction pipeline).
  const enabledSources = await db.source.count({
    where: { enabled: true, name: { not: "espn-results" } },
  });

  const recentScrapes = await db.scrapeLog.findMany({
    where: { createdAt: { gte: since } },
    select: { source: true, status: true, createdAt: true },
  });

  // Unique sources that succeeded in the last 24h
  const successfulSources = new Set<string>();
  let latestSuccessAt: Date | null = null;
  for (const log of recentScrapes) {
    if (log.status === "success") {
      successfulSources.add(log.source);
      if (!latestSuccessAt || log.createdAt > latestSuccessAt) {
        latestSuccessAt = log.createdAt;
      }
    }
  }

  const scraperSuccessRate = enabledSources > 0
    ? successfulSources.size / enabledSources
    : 0;

  const latestScrapeAgeHours = latestSuccessAt
    ? (Date.now() - latestSuccessAt.getTime()) / (1000 * 60 * 60)
    : 999; // no successful scrapes → very old

  // ── Match coverage ────────────────────────────────────────────────────
  const totalMatches = await db.match.count({ where: { matchDate: dateStr } });
  const matchesWithPredictions = await db.prediction.findMany({
    where: { match: { matchDate: dateStr } },
    select: { matchId: true },
    distinct: ["matchId"],
  });
  const matchCoverage = totalMatches > 0
    ? matchesWithPredictions.length / totalMatches
    : 0;

  return {
    scraperSuccessRate,
    matchCoverage,
    latestScrapeAgeHours,
  };
}

/**
 * Compute the data-quality decision for today's pipeline run.
 *
 * Convenience wrapper that fetches the context and calls `evaluateDataQuality`.
 */
export async function getDataQualityDecision(dateStr: string): Promise<DataQualityDecision> {
  const ctx = await computeDataQualityContext(dateStr);
  return evaluateDataQuality(ctx);
}

// ──────────────────────────────────────────────────────────────────────────────
// Combined risk-state helper — used by the engine
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute the COMBINED risk state for today's stake recommendations.
 *
 * Combines:
 *   1. Drawdown breaker (B2) — from the bankroll snapshot
 *   2. Daily-loss breaker (B5) — from today's settled StakeLedger rows
 *   3. Data-quality gate (B6) — from recent ScrapeLog + match coverage
 *
 * The effective stake multiplier is the PRODUCT of all three:
 *   effectiveMult = drawdownMult × dailyLossMult × dataQualityMult
 *
 * Returns the combined decision + per-component diagnostics for the UI.
 */
export interface CombinedRiskState {
  /** Final multiplier applied to every Kelly stake. */
  stakeMultiplier: number;
  /** Highest-severity state across all three breakers. */
  state: "normal" | "degraded" | "halted";
  /** Human-readable reason — surfaced in UI banner. */
  reason: string;
  /** Per-component breakdown for diagnostics / health endpoint. */
  drawdown: DrawdownDecision;
  dailyLoss: DailyLossDecision;
  dataQuality: DataQualityDecision;
}

export async function getCombinedRiskState(
  dateStr: string,
  drawdown: DrawdownDecision,
  currentBankroll: number
): Promise<CombinedRiskState> {
  const dailyLoss = await getDailyLossDecision(dateStr, currentBankroll);
  const dataQuality = await getDataQualityDecision(dateStr);

  // Combine drawdown + daily-loss (both are stake multipliers in [0, 1])
  const combined = combineRiskStates(drawdown, dailyLoss);

  // Apply data-quality gate on top (binary: 1.0 or 0.0)
  const finalMultiplier = combined.stakeMultiplier * dataQuality.stakeMultiplier;

  // Determine the overall state — most conservative wins
  let state: "normal" | "degraded" | "halted";
  if (finalMultiplier === 0) {
    state = "halted";
  } else if (finalMultiplier < 1.0) {
    state = "degraded";
  } else {
    state = "normal";
  }

  // Build the reason — prioritize the most severe blocker
  let reason: string;
  if (!dataQuality.pass) {
    reason = dataQuality.reason;
  } else if (combined.state === "halted") {
    reason = combined.reason;
  } else if (combined.state === "degraded") {
    reason = combined.reason;
  } else {
    reason = "All risk gates normal. Stakes at full Kelly.";
  }

  return {
    stakeMultiplier: finalMultiplier,
    state,
    reason,
    drawdown,
    dailyLoss,
    dataQuality,
  };
}
