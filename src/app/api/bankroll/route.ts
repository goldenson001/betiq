/**
 * GET /api/bankroll
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns bankroll history (daily snapshots) and current state.
 */
import { NextResponse } from "next/server";
import { getBankrollState, getBankrollHistory } from "@/lib/audit/bankroll";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;
    const startDate = params.get("startDate") ?? undefined;
    const endDate = params.get("endDate") ?? undefined;
    const limit = Math.min(365, parseInt(params.get("limit") ?? "90", 10));

    const [current, history] = await Promise.all([
      getBankrollState(),
      getBankrollHistory({ startDate, endDate, limit }),
    ]);

    return NextResponse.json({
      current,
      history: history.reverse(),
    });
  } catch (err) {
    console.error("[/api/bankroll] error:", err);
    return NextResponse.json(
      { error: "Failed to load bankroll state", detail: String(err) },
      { status: 500 }
    );
  }
}
