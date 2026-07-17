/**
 * GET /api/match/[id]
 * Returns a single match with all its predictions and raw source data.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const match = await db.match.findUnique({
    where: { id },
    include: {
      league: true,
      predictions: { orderBy: { confidence: "desc" } },
      rawPredictions: { include: { source: true } },
    },
  });
  if (!match) {
    return NextResponse.json({ ok: false, error: "Match not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, match });
}
