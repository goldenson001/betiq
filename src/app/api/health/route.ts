/**
 * GET /api/health
 * Liveness + production-readiness probe.
 *
 * Returns 200 + JSON status if the server is up and DB is reachable.
 * Beyond a basic liveness check, this endpoint surfaces production signals
 * needed for real-money operations:
 *
 *   - DB connectivity (basic liveness)
 *   - Source count + scraper success rate (last 24h)
 *   - Today's match count + parlay count
 *   - Last pipeline run date + status
 *   - Current bankroll state + drawdown state
 *   - Current data-quality decision (B6 gate)
 *   - Current daily-loss decision (B5 breaker)
 *
 * The endpoint NEVER throws — if any sub-check fails, it's reported in the
 * response payload with `status: "degraded"` or `status: "error"`, but the
 * overall response is still 200 (so monitoring doesn't double-alert).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { brusselsDateString } from "@/lib/time/brussels";
import { getBankrollState } from "@/lib/audit/bankroll";
import {
  computeDailyLossContext,
  getDataQualityDecision,
} from "@/lib/audit/risk-context";
import { computeDailyLossState } from "@/lib/learning/risk";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks = await runChecks();
  const overallStatus = deriveOverallStatus(checks);
  const httpStatus = overallStatus === "ok" ? 200 : 503;

  return NextResponse.json(
    {
      ok: overallStatus === "ok",
      status: overallStatus,
      ts: new Date().toISOString(),
      ...checks,
    },
    { status: httpStatus }
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-checks — each one is independently fault-tolerant
// ──────────────────────────────────────────────────────────────────────────────

interface HealthChecks {
  db: { status: "ok" | "error"; sources?: number; error?: string };
  pipeline: {
    status: "ok" | "stale" | "error";
    lastRunDate?: string;
    lastRunHoursAgo?: number;
    todayParlays?: number;
    todayMatches?: number;
    error?: string;
  };
  scrapers: {
    status: "ok" | "degraded" | "error";
    successRate?: number;
    successfulSources?: number;
    enabledSources?: number;
    latestScrapeAgeHours?: number;
    error?: string;
  };
  bankroll: {
    status: "ok" | "degraded" | "halted" | "cold_start" | "error";
    bankroll?: number;
    drawdownPct?: number;
    drawdownState?: string;
    reason?: string;
    error?: string;
  };
  risk: {
    status: "ok" | "degraded" | "halted" | "error";
    dailyLossFraction?: number;
    dailyLossState?: string;
    dataQuality?: unknown;
    combinedState?: string;
    reason?: string;
    error?: string;
  };
}

async function runChecks(): Promise<HealthChecks> {
  const checks: HealthChecks = {
    db: { status: "error" },
    pipeline: { status: "error" },
    scrapers: { status: "error" },
    bankroll: { status: "error" },
    risk: { status: "error" },
  };

  // ── DB check ──────────────────────────────────────────────────────────
  try {
    const count = await db.source.count();
    checks.db = { status: "ok", sources: count };
  } catch (err) {
    checks.db = { status: "error", error: err instanceof Error ? err.message : String(err) };
    // If DB is down, the other checks will all fail too — bail early.
    return checks;
  }

  // ── Pipeline + scraper checks ─────────────────────────────────────────
  try {
    const todayStr = brusselsDateString();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [lastPipeline, todayParlays, todayMatches, recentScrapes, enabledSources] = await Promise.all([
      db.modelState.findUnique({ where: { key: "last_pipeline_run_date" } }),
      db.parlay.count({ where: { matchDate: todayStr } }),
      db.match.count({ where: { matchDate: todayStr } }),
      db.scrapeLog.findMany({
        where: { createdAt: { gte: since } },
        select: { source: true, status: true, createdAt: true },
      }),
      db.source.count({ where: { enabled: true, name: { not: "espn-results" } } }),
    ]);

    // Pipeline freshness
    if (lastPipeline?.notes) {
      const lastRunDate = lastPipeline.notes;
      const lastRunMs = new Date(lastRunDate).getTime();
      const hoursAgo = (Date.now() - lastRunMs) / (1000 * 60 * 60);
      checks.pipeline = {
        status: hoursAgo <= 30 ? "ok" : "stale", // 30h grace period for midnight scheduler
        lastRunDate,
        lastRunHoursAgo: Math.round(hoursAgo * 10) / 10,
        todayParlays,
        todayMatches,
      };
    } else {
      checks.pipeline = {
        status: "stale",
        lastRunDate: "never",
        lastRunHoursAgo: -1,
        todayParlays,
        todayMatches,
      };
    }

    // Scraper success
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
    const successRate = enabledSources > 0 ? successfulSources.size / enabledSources : 0;
    const latestAge = latestSuccessAt
      ? (Date.now() - latestSuccessAt.getTime()) / (1000 * 60 * 60)
      : 999;
    checks.scrapers = {
      status: successRate >= 0.70 && latestAge <= 24 ? "ok" : "degraded",
      successRate: Math.round(successRate * 100) / 100,
      successfulSources: successfulSources.size,
      enabledSources,
      latestScrapeAgeHours: Math.round(latestAge * 10) / 10,
    };
  } catch (err) {
    checks.pipeline = { status: "error", error: err instanceof Error ? err.message : String(err) };
    checks.scrapers = { status: "error", error: err instanceof Error ? err.message : String(err) };
  }

  // ── Bankroll state ────────────────────────────────────────────────────
  try {
    const bankroll = await getBankrollState();
    checks.bankroll = {
      status: bankroll.drawdownState === "normal" ? "ok"
        : bankroll.drawdownState === "degraded" ? "degraded"
        : "halted",
      bankroll: Math.round(bankroll.bankroll * 100) / 100,
      drawdownPct: Math.round(bankroll.drawdownPct * 1000) / 10,
      drawdownState: bankroll.drawdownState,
      reason: bankroll.reason,
    };
    // Cold start = no snapshots yet
    if (bankroll.lastSnapshotDate === null) {
      checks.bankroll.status = "cold_start";
    }
  } catch (err) {
    checks.bankroll = { status: "error", error: err instanceof Error ? err.message : String(err) };
  }

  // ── Risk state (B5 daily-loss + B6 data-quality) ─────────────────────
  try {
    const todayStr = brusselsDateString();
    const bankroll = checks.bankroll.bankroll ?? 1000;

    const [dailyLossCtx, dataQualityDecision] = await Promise.all([
      computeDailyLossContext(todayStr, bankroll),
      getDataQualityDecision(todayStr),
    ]);
    const dailyLossDecision = computeDailyLossState(dailyLossCtx);

    const combinedState =
      dailyLossDecision.state === "halted" || !dataQualityDecision.pass ? "halted"
      : dailyLossDecision.state === "degraded" ? "degraded"
      : "ok";

    checks.risk = {
      status: combinedState as "ok" | "degraded" | "halted",
      dailyLossFraction: Math.round(dailyLossCtx.todayLossFraction * 10000) / 100, // as %
      dailyLossState: dailyLossDecision.state,
      dataQuality: {
        pass: dataQualityDecision.pass,
        checks: dataQualityDecision.checks,
        reason: dataQualityDecision.reason,
      },
      combinedState,
      reason: !dataQualityDecision.pass
        ? dataQualityDecision.reason
        : dailyLossDecision.state !== "normal"
          ? dailyLossDecision.reason
          : "All risk gates normal.",
    };
  } catch (err) {
    checks.risk = { status: "error", error: err instanceof Error ? err.message : String(err) };
  }

  return checks;
}

function deriveOverallStatus(checks: HealthChecks): "ok" | "degraded" | "error" {
  if (checks.db.status === "error") return "error";

  const statuses = [
    checks.pipeline.status,
    checks.scrapers.status,
    checks.bankroll.status === "cold_start" ? "ok" : checks.bankroll.status,
    checks.risk.status,
  ];

  if (statuses.some((s) => s === "error")) return "error";
  if (statuses.some((s) => s === "halted" || s === "stale" || s === "degraded")) return "degraded";
  return "ok";
}
