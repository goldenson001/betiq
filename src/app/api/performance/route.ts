/**
 * GET /api/performance
 * Returns historical performance snapshots + per-source accuracy.
 * Query: days=30 (default 30 days lookback)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const days = parseInt(searchParams.get("days") ?? "30", 10);

  const snapshots = await db.performanceSnapshot.findMany({
    orderBy: { date: "asc" },
    take: days,
  });

  const sources = await db.source.findMany({
    orderBy: { weight: "desc" },
  });

  // Compute aggregate stats
  const totalPredictions = snapshots.reduce((s, x) => s + x.totalPredictions, 0);
  const totalCorrect = snapshots.reduce((s, x) => s + x.correctPredictions, 0);
  const aggregateWinRate = totalPredictions > 0 ? totalCorrect / totalPredictions : 0;
  const aggregateRoi = snapshots.length > 0
    ? snapshots.reduce((s, x) => s + x.roi, 0) / snapshots.length
    : 0;
  const parlaysMade = snapshots.reduce((s, x) => s + x.parlaysMade, 0);
  const parlaysWon = snapshots.reduce((s, x) => s + x.parlaysWon, 0);

  // Parse per-market breakdown aggregated across all snapshots
  const marketAgg: Record<string, { total: number; correct: number }> = {};
  for (const s of snapshots) {
    if (!s.marketBreakdownJson) continue;
    try {
      const obj = JSON.parse(s.marketBreakdownJson) as Record<string, { total: number; correct: number }>;
      for (const [k, v] of Object.entries(obj)) {
        const e = marketAgg[k] ?? { total: 0, correct: 0 };
        e.total += v.total;
        e.correct += v.correct;
        marketAgg[k] = e;
      }
    } catch { /* ignore */ }
  }

  return NextResponse.json({
    ok: true,
    snapshots: snapshots.map((s) => ({
      ...s,
      marketBreakdown: s.marketBreakdownJson ? JSON.parse(s.marketBreakdownJson) : {},
    })),
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      displayName: s.displayName,
      weight: s.weight,
      accuracy: s.accuracy,
      totalPredictions: s.totalPredictions,
      correctPredictions: s.correctPredictions,
      roi: s.roi,
      enabled: s.enabled,
      lastScrapedAt: s.lastScrapedAt,
    })),
    aggregates: {
      totalPredictions,
      totalCorrect,
      aggregateWinRate,
      aggregateRoi,
      parlaysMade,
      parlaysWon,
      parlayWinRate: parlaysMade > 0 ? parlaysWon / parlaysMade : 0,
    },
    marketAgg,
  });
}
