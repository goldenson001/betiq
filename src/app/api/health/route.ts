/**
 * GET /api/health
 * Liveness probe for container orchestration / Docker healthchecks.
 * Returns 200 + JSON status if the server is up and DB is reachable.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Simple DB ping — count sources (cheap, indexed)
    const count = await db.source.count();
    return NextResponse.json({
      ok: true,
      ts: new Date().toISOString(),
      db: "ok",
      sources: count,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        ts: new Date().toISOString(),
        db: "error",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503 }
    );
  }
}
