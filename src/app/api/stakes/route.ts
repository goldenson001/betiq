/**
 * GET /api/stakes
 * ─────────────────────────────────────────────────────────────────────────────
 * Query the stake ledger — the source of truth for actual money P&L.
 */
import { NextResponse } from "next/server";
import { getStakeLedger, aggregateStakeLedgerByTier } from "@/lib/audit/stake-ledger";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;

    const matchDate = params.get("date") ?? undefined;
    const startDate = params.get("startDate") ?? undefined;
    const endDate = params.get("endDate") ?? undefined;
    const tier = params.get("tier") ?? undefined;
    const status = params.get("status") ?? undefined;
    const limit = Math.min(500, parseInt(params.get("limit") ?? "100", 10));
    const aggregate = params.get("aggregate") === "true";

    if (aggregate) {
      const agg = await aggregateStakeLedgerByTier({ startDate, endDate });
      return NextResponse.json({
        mode: "aggregate",
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        tiers: agg,
      });
    }

    const rows = await getStakeLedger({
      matchDate,
      startDate,
      endDate,
      tier,
      status,
      limit,
    });

    return NextResponse.json({
      mode: "detail",
      count: rows.length,
      stakes: rows,
    });
  } catch (err) {
    console.error("[/api/stakes] error:", err);
    return NextResponse.json(
      { error: "Failed to load stake ledger", detail: String(err) },
      { status: 500 }
    );
  }
}
