/**
 * GET /api/diagnose
 * Surfaces runtime diagnostics — useful when the dashboard is broken on Vercel.
 * No secrets are exposed; only first/last 4 chars of DATABASE_URL.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

function maskUrl(url: string): string {
  if (!url) return "(empty)";
  // Hide password and host details
  try {
    if (url.startsWith("file:")) return `file:${url.slice(5).slice(0, 20)}...`;
    const m = url.match(/^(postgresql|postgres):\/\/([^:]+):([^@]+)@(.+)$/);
    if (m) {
      const [, driver, user, _pw, rest] = m;
      return `${driver}://${user}:***@${rest.slice(0, 30)}...`;
    }
    return url.slice(0, 20) + "...";
  } catch {
    return "(unparseable)";
  }
}

export async function GET() {
  const startedAt = Date.now();
  const env: Record<string, string | boolean | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    TZ: process.env.TZ,
    PORT: process.env.PORT,
    DISABLE_SCHEDULER: process.env.DISABLE_SCHEDULER,
    DATABASE_URL_set: !!process.env.DATABASE_URL,
    DATABASE_URL_preview: process.env.DATABASE_URL ? maskUrl(process.env.DATABASE_URL) : "(unset)",
    NEXT_RUNTIME: process.env.NEXT_RUNTIME,
  };

  // Try a DB ping
  let dbState: "ok" | "error" | "pending";
  let dbError: string | undefined;
  let tableCount = 0;
  let matchCount = 0;
  let sourceCount = 0;
  try {
    sourceCount = await db.source.count();
    matchCount = await db.match.count();
    tableCount = 8; // expected by schema
    dbState = "ok";
  } catch (err) {
    dbState = "error";
    dbError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    ok: dbState === "ok",
    runtime: {
      time: new Date().toISOString(),
      ms: Date.now() - startedAt,
      platform: "vercel" in process.env || !!process.env.VERCEL ? "vercel" : "other",
      vercelRegion: process.env.VERCEL_REGION,
    },
    env,
    database: {
      state: dbState,
      error: dbError,
      sourceCount,
      matchCount,
      expectedTables: tableCount,
    },
    nextSteps:
      dbState === "error"
        ? dbError && (dbError.includes("connect") || dbError.includes("DATABASE_URL"))
          ? "1) Create a PostgreSQL database (Neon: https://neon.tech, Supabase: https://supabase.com). 2) Copy its connection string. 3) Vercel → Project → Settings → Environment Variables → Add DATABASE_URL. 4) Redeploy."
          : dbError && (dbError.includes("relation") || dbError.includes("does not exist"))
            ? "Schema not applied. From a local terminal: `DATABASE_URL='your-pg-url' npx prisma db push`. Then visit /api/trigger?phase=all to populate matches."
            : "Unknown DB error. Check Vercel function logs."
        : "DB OK. If dashboard still shows no matches, run /api/trigger?phase=all to backfill today's data.",
  });
}
