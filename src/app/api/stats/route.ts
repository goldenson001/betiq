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
      include: { match: { include: { league: true } } },
    }),
    db.parlay.findMany({ where: { matchDate: date } }),
    db.source.findMany(),
    db.scrapeLog.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);

  const topPicks = predictions
    .filter((p) => p.isTopPick)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  // Value bets — ONE best value bet per match, so every predicted match is
  // represented in the Value Bets tab. Falls back to the highest-edge pick
  // per match when no prediction clears the strict value-bet threshold
  // (edge ≥ 2.5%, prob in [0.40, 0.82]). This avoids the bug where the tab
  // appeared empty even when matches were predicted.
  const valueByMatch = new Map<string, (typeof predictions)[number]>();
  const valueFallbackByMatch = new Map<string, (typeof predictions)[number]>();
  const VALUE_COMPOSITE = new Set(["bet_builder", "correct_score", "htft"]);
  for (const p of predictions) {
    if (VALUE_COMPOSITE.has(p.market)) continue;
    if (p.isValueBet) {
      const existing = valueByMatch.get(p.matchId);
      const a = p.edge ?? -Infinity;
      const b = existing?.edge ?? -Infinity;
      if (!existing || a > b) {
        valueByMatch.set(p.matchId, p);
      }
    } else if (p.edge !== null && p.edge !== undefined) {
      const existing = valueFallbackByMatch.get(p.matchId);
      const a = p.edge ?? -Infinity;
      const b = existing?.edge ?? -Infinity;
      if (!existing || a > b) {
        valueFallbackByMatch.set(p.matchId, p);
      }
    }
  }
  const allValueByMatch = new Map<string, (typeof predictions)[number]>();
  const allValueMatchIds = new Set<string>([...valueByMatch.keys(), ...valueFallbackByMatch.keys()]);
  for (const matchId of allValueMatchIds) {
    const trueValue = valueByMatch.get(matchId);
    const fallback = valueFallbackByMatch.get(matchId);
    if (trueValue) {
      allValueByMatch.set(matchId, trueValue);
    } else if (fallback) {
      allValueByMatch.set(matchId, fallback);
    }
  }

  const valueBets = Array.from(allValueByMatch.values())
    .sort((a, b) => {
      const aVal = a.isValueBet ? 1 : 0;
      const bVal = b.isValueBet ? 1 : 0;
      if (aVal !== bVal) return bVal - aVal;
      return (b.edge ?? 0) - (a.edge ?? 0);
    })
    .slice(0, 10);

  // Safe picks — ONE safest pick per match, so every predicted match is
  // represented in the Safe Picks tab. The top pick of a match is OFTEN the
  // safest pick (highest probability), so we DO NOT exclude top picks —
  // excluding them was the bug that made the tab appear empty even when
  // matches were predicted. Skip composite markets (bet_builder / correct_score /
  // htft / win_btts) since those aren't standalone safety picks.
  //
  // For each match:
  //   1. Find all predictions flagged isSafePick=true.
  //   2. If any exist, take the highest-probability one (TRUE SAFE — green badge).
  //   3. If NONE exist for this match, fall back to the highest-probability
  //      non-composite pick (BEST AVAILABLE — amber badge). This ensures the
  //      tab NEVER appears empty when matches are predicted, even if all
  //      probabilities fell just below the strict safe thresholds.
  const COMPOSITE_MARKETS = new Set(["bet_builder", "correct_score", "htft", "win_btts"]);
  const safeByMatch = new Map<string, (typeof predictions)[number]>();
  const fallbackByMatch = new Map<string, (typeof predictions)[number]>();
  for (const p of predictions) {
    if (COMPOSITE_MARKETS.has(p.market)) continue;
    if (p.isSafePick) {
      const existing = safeByMatch.get(p.matchId);
      if (!existing || p.probability > existing.probability) {
        safeByMatch.set(p.matchId, p);
      }
    } else {
      const existing = fallbackByMatch.get(p.matchId);
      if (!existing || p.probability > existing.probability) {
        fallbackByMatch.set(p.matchId, p);
      }
    }
  }
  // Merge: prefer true safe; fall back to best-available for matches without.
  const allSafeByMatch = new Map<string, (typeof predictions)[number]>();
  const allMatchIds = new Set<string>([...safeByMatch.keys(), ...fallbackByMatch.keys()]);
  for (const matchId of allMatchIds) {
    const trueSafe = safeByMatch.get(matchId);
    const fallback = fallbackByMatch.get(matchId);
    if (trueSafe) {
      allSafeByMatch.set(matchId, trueSafe);
    } else if (fallback) {
      allSafeByMatch.set(matchId, fallback);
    }
  }

  const safePicks = Array.from(allSafeByMatch.values())
    .sort((a, b) => {
      // True safe picks first, then by probability desc.
      const aSafe = a.isSafePick ? 1 : 0;
      const bSafe = b.isSafePick ? 1 : 0;
      if (aSafe !== bSafe) return bSafe - aSafe;
      return b.probability - a.probability;
    })
    .slice(0, 10);

  // Safe High-Odds picks — investment-grade picks with HIGHER ODDS (1.50–2.50)
  // that pass ALL safety precautions: multi-source consensus, strong edge,
  // positive Kelly, safe market. These are surfaced in the dedicated
  // "Safe High-Odds" tab. Sort by edge desc (best value first), break ties
  // by odds desc (highest return first).
  const safeHighOddsPicks = predictions
    .filter((p) => p.isSafeHighOdds)
    .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0) || (b.bookOdds ?? 0) - (a.bookOdds ?? 0))
    .slice(0, 10);

  // Group matches by league
  const leagueCounts = new Map<string, number>();
  for (const m of matches) {
    const name = m.league?.name ?? "Other";
    leagueCounts.set(name, (leagueCounts.get(name) ?? 0) + 1);
  }

  // ── C1: Load drawdown state + today's total exposure for the bankroll sim ──
  const drawdownRow = await db.modelState.findUnique({ where: { key: "drawdown_state" } });
  let drawdownState: "normal" | "degraded" | "halted" = "normal";
  if (drawdownRow) {
    if (drawdownRow.value >= 2) drawdownState = "halted";
    else if (drawdownRow.value >= 1) drawdownState = "degraded";
  }
  // Today's total exposure = sum of recommendedStake across all bets today
  const todayExposure = predictions
    .filter((p) => (p.isTopPick || p.isValueBet) && p.recommendedStake !== null && p.recommendedStake > 0)
    .reduce((sum, p) => sum + (p.recommendedStake ?? 0), 0);

  return NextResponse.json({
    ok: true,
    date,
    stats: {
      totalMatches: matches.length,
      totalPredictions: predictions.length,
      totalParlays: parlays.length,
      leaguesCovered: leagueCounts.size,
      topPicksCount: predictions.filter((p) => p.isTopPick).length,
      valueBetsCount: allValueByMatch.size,
      safePicksCount: allSafeByMatch.size,
      safeHighOddsCount: predictions.filter((p) => p.isSafeHighOdds).length,
    },
    // ── C1: Risk gate info for the bankroll simulator + UI banner ──────────────
    riskGate: {
      drawdownState,
      drawdownReason: drawdownRow?.notes ?? null,
      todayExposure,
      maxExposure: 0.15, // matches ENGINE_CONFIG.DAILY_MAX_EXPOSURE
      portfolioScale: todayExposure > 0.15 ? 0.15 / todayExposure : 1.0,
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
      isSafeHighOdds: p.isSafeHighOdds,
      consensusSources: p.consensusSources,
      recommendedStake: p.recommendedStake,
      clv: p.clv,
    })),
    valueBets: valueBets.map((p) => ({
      id: p.id,
      match: `${p.match.homeTeam} v ${p.match.awayTeam}`,
      league: p.match.league?.name ?? null,
      kickoffBrussels: p.match.kickoffBrussels ?? null,
      market: p.market,
      selection: p.selection,
      confidence: p.confidence,
      probability: p.probability,
      bookOdds: p.bookOdds,
      edge: p.edge,
      isSafePick: p.isSafePick,
      isSafeHighOdds: p.isSafeHighOdds,
      isTopPick: p.isTopPick,
      isValueBet: p.isValueBet,
      consensusSources: p.consensusSources,
      recommendedStake: p.recommendedStake,
      clv: p.clv,
    })),
    safePicks: safePicks.map((p) => ({
      id: p.id,
      match: `${p.match.homeTeam} v ${p.match.awayTeam}`,
      league: p.match.league?.name ?? null,
      kickoffBrussels: p.match.kickoffBrussels ?? null,
      market: p.market,
      selection: p.selection,
      confidence: p.confidence,
      probability: p.probability,
      bookOdds: p.bookOdds,
      edge: p.edge,
      isSafePick: p.isSafePick,
      isTopPick: p.isTopPick,
      consensusSources: p.consensusSources,
      recommendedStake: p.recommendedStake,
      clv: p.clv,
    })),
    safeHighOddsPicks: safeHighOddsPicks.map((p) => ({
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
      disagreement: p.disagreement,
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
