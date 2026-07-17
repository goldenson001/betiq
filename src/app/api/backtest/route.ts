/**
 * GET /api/backtest
 * ──────────────────
 * Runs a backtest over a historical date range and returns detailed metrics.
 *
 * Query params:
 *   - startDate=YYYY-MM-DD (required)
 *   - endDate=YYYY-MM-DD   (required)
 *
 * Note: Backtests are heavy — 1-2s per day of history. For ranges longer
 * than 30 days, prefer the CLI script (scripts/backtest.ts) which has no
 * function timeout.
 *
 * GET /api/backtest?range=true returns the available backtest date range
 * (earliest/latest date with finished matches) without running a backtest.
 */

import { NextRequest, NextResponse } from "next/server";
import { runBacktest, getBacktestRange } from "@/lib/learning/backtest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rangeOnly = searchParams.get("range") === "true";
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");

  if (rangeOnly) {
    const range = await getBacktestRange();
    return NextResponse.json({ ok: true, range });
  }

  if (!startDate || !endDate) {
    return NextResponse.json(
      { ok: false, error: "Missing startDate or endDate. Usage: /api/backtest?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD" },
      { status: 400 }
    );
  }

  // Validate date format
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(startDate) || !dateRe.test(endDate)) {
    return NextResponse.json(
      { ok: false, error: "Dates must be in YYYY-MM-DD format" },
      { status: 400 }
    );
  }
  if (new Date(startDate) > new Date(endDate)) {
    return NextResponse.json(
      { ok: false, error: "startDate must be on or before endDate" },
      { status: 400 }
    );
  }

  try {
    const result = await runBacktest(startDate, endDate);
    return NextResponse.json({ ok: true, backtest: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `Backtest failed: ${msg}` },
      { status: 500 }
    );
  }
}
