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
import { snapshotOddsForDate } from "@/lib/learning/clv";
import { brusselsDateString } from "@/lib/time/brussels";
import { db } from "@/lib/db";
import { PrismaClientInitializationError } from "@prisma/client/runtime/library";

export const maxDuration = 300; // 5 min for pipeline runs
export const dynamic = "force-dynamic";

function friendlyError(err: unknown): { status: number; body: Record<string, unknown> } {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  // Database not reachable / not configured
  if (
    err instanceof PrismaClientInitializationError ||
    msg.includes("connect") ||
    msg.includes("DATABASE_URL") ||
    msg.includes("Timed out fetching a connection")
  ) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "Database connection failed.",
        detail: msg,
        hint:
          "Set DATABASE_URL in Vercel → Project → Settings → Environment Variables. " +
          "Use a PostgreSQL connection string (e.g. Neon, Supabase). SQLite is not supported on Vercel.",
      },
    };
  }

  // Schema not applied
  if (
    msg.includes("relation") ||
    msg.includes("no such table") ||
    msg.includes("does not exist") ||
    msg.includes("P2021")
  ) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "Database schema not applied.",
        detail: msg,
        hint:
          "Run `npx prisma db push` against your DATABASE_URL from a local terminal, or use the prisma migrate CLI. The schema is in prisma/schema.prisma.",
      },
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: msg,
      stack: process.env.NODE_ENV === "production" ? undefined : stack,
    },
  };
}

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
    // D1: snapshot phase — capture mid-day odds for steam-move detection
    if (phase === "snapshot") {
      const result = await snapshotOddsForDate(date);
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
    const { status, body } = friendlyError(err);
    return NextResponse.json(body, { status });
  }
}
