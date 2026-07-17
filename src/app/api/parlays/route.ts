/**
 * GET /api/parlays
 * Returns all parlays for a given Brussels date.
 * Query: date=YYYY-MM-DD (default: today Brussels)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { brusselsDateString } from "@/lib/time/brussels";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") ?? brusselsDateString();

  const parlays = await db.parlay.findMany({
    where: { matchDate: date },
    orderBy: { type: "asc" },
  });

  // Parse legs JSON for response
  const parsed = parlays.map((p) => ({
    ...p,
    legs: JSON.parse(p.legsJson),
  }));

  return NextResponse.json({ ok: true, date, parlays: parsed });
}
