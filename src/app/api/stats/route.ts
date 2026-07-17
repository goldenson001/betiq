/**
 * GET /api/stats
 * Returns quick dashboard stats: counts, top picks, value bets, source health.
 * Query: date=YYYY-MM-DD (default: today Brussels)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { brusselsDateString } from "@/lib/time/brussels";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") ?? brusselsDateString();

  const [matches, predictions, parlays, sources, scrapeLogs] = await Promise.all([
    db.match.findMany({ where: { matchDate: date }, include: { league: true } }),
    db.prediction.findMany({
      where: { match: { matchDate: date } },
      include: { match: true },
    }),
    db.parlay.findMany({ where: { matchDate: date } }),
    db.source.findMany(),
    db.scrapeLog.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);

  const topPicks = predictions
    .filter((p) => p.isTopPick)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  const valueBets = predictions
    .filter((p) => p.isValueBet)
    .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0))
    .slice(0, 5);

  // Safe picks — the lower-risk side of each market per match. Surface the
  // top 5 by probability so users can see the highest-confidence "safe"
  // recommendations even when no value bets exist (e.g. only 1 source).
  const safePicks = predictions
    .filter((p) => p.isSafePick && !p.isTopPick)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5);

  // Group matches by league
  const leagueCounts = new Map<string, number>();
  for (const m of matches) {
    const name = m.league?.name ?? "Other";
    leagueCounts.set(name, (leagueCounts.get(name) ?? 0) + 1);
  }

  return NextResponse.json({
    ok: true,
    date,
    stats: {
      totalMatches: matches.length,
      totalPredictions: predictions.length,
      totalParlays: parlays.length,
      leaguesCovered: leagueCounts.size,
      topPicksCount: predictions.filter((p) => p.isTopPick).length,
      valueBetsCount: predictions.filter((p) => p.isValueBet).length,
      safePicksCount: predictions.filter((p) => p.isSafePick).length,
    },
    leagueCounts: Array.from(leagueCounts.entries()).map(([name, count]) => ({ name, count })),
    topPicks: topPicks.map((p) => ({
      id: p.id,
      match: `${p.match.homeTeam} v ${p.match.awayTeam}`,
      market: p.market,
      selection: p.selection,
      confidence: p.confidence,
      probability: p.probability,
      bookOdds: p.bookOdds,
      edge: p.edge,
      isSafePick: p.isSafePick,
      consensusSources: p.consensusSources,
      recommendedStake: p.recommendedStake,
      clv: p.clv,
    })),
    valueBets: valueBets.map((p) => ({
      id: p.id,
      match: `${p.match.homeTeam} v ${p.match.awayTeam}`,
      market: p.market,
      selection: p.selection,
      confidence: p.confidence,
      probability: p.probability,
      bookOdds: p.bookOdds,
      edge: p.edge,
      isSafePick: p.isSafePick,
      consensusSources: p.consensusSources,
      recommendedStake: p.recommendedStake,
      clv: p.clv,
    })),
    safePicks: safePicks.map((p) => ({
      id: p.id,
      match: `${p.match.homeTeam} v ${p.match.awayTeam}`,
      market: p.market,
      selection: p.selection,
      confidence: p.confidence,
      probability: p.probability,
      bookOdds: p.bookOdds,
      edge: p.edge,
      consensusSources: p.consensusSources,
      recommendedStake: p.recommendedStake,
      clv: p.clv,
    })),
    sources: sources.map((s) => ({
      name: s.name,
      displayName: s.displayName,
      weight: s.weight,
      accuracy: s.accuracy,
      enabled: s.enabled,
      lastScrapedAt: s.lastScrapedAt,
    })),
    recentScrapeLogs: scrapeLogs,
  });
}
