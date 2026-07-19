/**
 * GET /api/audit/picks
 * ─────────────────────────────────────────────────────────────────────────────
 * Query the immutable pick audit log.
 *
 * Query params:
 *   ?date=YYYY-MM-DD        — single date
 *   ?startDate=YYYY-MM-DD   — range start (inclusive)
 *   ?endDate=YYYY-MM-DD     — range end (inclusive)
 *   ?tier=safest            — filter by tier
 *   ?settled=true|false     — only settled / only pending
 *   ?won=true|false         — only winning / only losing picks (settled only)
 *   ?limit=100              — max results (cap 500)
 *   ?aggregate=true         — per-tier realized performance
 */
import { NextResponse } from "next/server";
import { queryPickAudits, aggregatePickAuditByTier } from "@/lib/audit/pick-audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;

    const matchDate = params.get("date") ?? undefined;
    const startDate = params.get("startDate") ?? undefined;
    const endDate = params.get("endDate") ?? undefined;
    const tier = params.get("tier") ?? undefined;
    const settled = params.get("settled");
    const won = params.get("won");
    const limit = Math.min(500, parseInt(params.get("limit") ?? "100", 10));
    const aggregate = params.get("aggregate") === "true";

    if (aggregate) {
      const agg = await aggregatePickAuditByTier({ startDate, endDate });
      return NextResponse.json({
        mode: "aggregate",
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        tiers: agg,
      });
    }

    const rows = await queryPickAudits({
      matchDate,
      startDate,
      endDate,
      tier,
      settledOnly: settled === "true" ? true : settled === "false" ? false : undefined,
      wonOnly: won === "true" ? true : undefined,
      lostOnly: won === "false" ? true : undefined,
      limit,
    });

    return NextResponse.json({
      mode: "detail",
      count: rows.length,
      picks: rows,
    });
  } catch (err) {
    console.error("[/api/audit/picks] error:", err);
    return NextResponse.json(
      { error: "Failed to query audit log", detail: String(err) },
      { status: 500 }
    );
  }
}
