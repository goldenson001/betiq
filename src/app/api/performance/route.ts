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

  // Advanced ML metrics (averaged across snapshots that have them)
  const clvSnapshots = snapshots.filter((s) => s.avgClv !== 0);
  const aggregateClv = clvSnapshots.length > 0
    ? clvSnapshots.reduce((s, x) => s + (x.avgClv ?? 0), 0) / clvSnapshots.length
    : undefined;
  const kellySnapshots = snapshots.filter((s) => s.kellyRoi !== 0);
  const aggregateKellyRoi = kellySnapshots.length > 0
    ? kellySnapshots.reduce((s, x) => s + (x.kellyRoi ?? 0), 0) / kellySnapshots.length
    : undefined;
  const brierSnapshots = snapshots.filter((s) => s.calibrationError !== 0);
  const aggregateBrier = brierSnapshots.length > 0
    ? brierSnapshots.reduce((s, x) => s + (x.calibrationError ?? 0), 0) / brierSnapshots.length
    : undefined;

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
      // Platt calibration params (omitted if never fitted)
      calibrationA: s.calibrationA !== 1 ? s.calibrationA : undefined,
      calibrationB: s.calibrationB !== 0 ? s.calibrationB : undefined,
      calibrationN: s.calibrationN > 0 ? s.calibrationN : undefined,
    })),
    aggregates: {
      totalPredictions,
      totalCorrect,
      aggregateWinRate,
      aggregateRoi,
      parlaysMade,
      parlaysWon,
      parlayWinRate: parlaysMade > 0 ? parlaysWon / parlaysMade : 0,
      aggregateClv,
      aggregateKellyRoi,
      aggregateBrier,
    },
    marketAgg,
  });
}
