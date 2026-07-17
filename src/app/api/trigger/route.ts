/**
 * GET /api/trigger
 * Manually triggers the full daily pipeline. Useful for testing or for
 * running on-demand outside the scheduled 00:00 Brussels window.
 *
 * Query params:
 *   - date=YYYY-MM-DD (optional — defaults to today Brussels)
 *   - phase=scrape|predict|parlays|feedback|all (default: all)
 */

import { NextRequest, NextResponse } from "next/server";
import { runDailyPipeline } from "@/lib/scheduler/pipeline";
import { runAllScrapers } from "@/lib/scrapers/orchestrator";
import { generatePredictionsForDate } from "@/lib/prediction/engine";
import { buildAndPersistParlays } from "@/lib/confidence/engine";
import { runFeedbackLoopForUnprocessedDates } from "@/lib/learning/feedback";
import { brusselsDateString } from "@/lib/time/brussels";
import { db } from "@/lib/db";

export const maxDuration = 300; // 5 min for pipeline runs

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") ?? brusselsDateString();
  const phase = searchParams.get("phase") ?? "all";

  try {
    if (phase === "scrape") {
      const result = await runAllScrapers(date);
      return NextResponse.json({ ok: true, phase, date, result });
    }
    if (phase === "predict") {
      const result = await generatePredictionsForDate(date);
      return NextResponse.json({ ok: true, phase, date, result });
    }
    if (phase === "parlays") {
      const result = await buildAndPersistParlays(date);
      return NextResponse.json({ ok: true, phase, date, result });
    }
    if (phase === "feedback") {
      const result = await runFeedbackLoopForUnprocessedDates();
      // Also update last-run marker
      await db.modelState.upsert({
        where: { key: "last_feedback_run_date" },
        create: { key: "last_feedback_run_date", value: Number(Date.now()), notes: new Date().toISOString() },
        update: { value: Number(Date.now()), notes: new Date().toISOString() },
      });
      return NextResponse.json({ ok: true, phase, date, result });
    }
    // all
    const result = await runDailyPipeline(date);
    // Update last-run marker
    await db.modelState.upsert({
      where: { key: "last_pipeline_run_date" },
      create: { key: "last_pipeline_run_date", value: parseFloat(date.replace(/-/g, "")), notes: date },
      update: { value: parseFloat(date.replace(/-/g, "")), notes: date },
    });
    return NextResponse.json({ ok: true, phase, date, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
