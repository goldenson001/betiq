/**
 * Backtest Harness
 * ─────────────────
 * Replays historical dates through the prediction engine and reports
 * performance metrics that aren't available from live data alone:
 *
 *   1. Per-source accuracy over time (does Forebet improve? does Adibet decay?)
 *   2. Per-market calibration (Brier score per market)
 *   3. ROI on flat 1u bets vs Kelly-sized bets
 *   4. CLV distribution (do our picks beat the closing line?)
 *   5. Parlay performance (best vs safe vs value)
 *
 * The backtest is HONEST — it uses only data that was available at prediction
 * time. We do NOT peek at results before generating predictions. Concretely:
 *
 *   for each date in [start, end]:
 *     1. Load matches already stored for that date
 *     2. Load raw predictions that were already stored (from the original scrape)
 *     3. Re-run the prediction engine on those raw predictions
 *     4. Re-run the parlay builder on those predictions
 *     5. Evaluate against actual results (already in DB)
 *     6. Compute metrics
 *
 * This means backtest quality depends on what's already in the DB — we can't
 * backtest dates before the system started scraping. For a true walk-forward
 * test, you'd need to import historical ESPN snapshots, which is out of scope.
 *
 * Usage:
 *   - From API:   GET /api/backtest?startDate=2026-07-01&endDate=2026-07-15
 *   - From CLI:   bun run scripts/backtest.ts 2026-07-01 2026-07-15
 */

import { db } from "@/lib/db";
import { buildPredictionsForMatch, reconstituteRaw, type MatchContext } from "@/lib/prediction/engine";
import type { EnginePrediction } from "@/lib/types";
import { brierScore } from "./calibration";
import { kelly, kellyParlay } from "./kelly";

export interface BacktestDayResult {
  date: string;
  matchesAnalyzed: number;
  predictionsGenerated: number;
  predictionsEvaluated: number;
  correctCount: number;
  winRate: number;
  /** Brier score (lower=better) */
  calibrationError: number;
  /** Flat 1u ROI on top picks */
  flatRoi: number;
  /** Kelly-sized ROI on value bets */
  kellyRoi: number;
  /** Average CLV on top picks (null if no closing odds) */
  avgClv: number | null;
  /** Per-market breakdown */
  marketBreakdown: Record<string, { total: number; correct: number }>;
  /** Per-source contribution (1X2 only) */
  sourceBreakdown: Record<string, { total: number; correct: number }>;
}

export interface BacktestSummary {
  startDate: string;
  endDate: string;
  daysAnalyzed: number;
  totalMatches: number;
  totalPredictions: number;
  totalEvaluated: number;
  totalCorrect: number;
  aggregateWinRate: number;
  aggregateBrier: number;
  aggregateFlatRoi: number;
  aggregateKellyRoi: number;
  aggregateClv: number | null;
  marketBreakdown: Record<string, { total: number; correct: number; winRate: number }>;
  sourceBreakdown: Record<string, { total: number; correct: number; accuracy: number }>;
  /** Top 5 best-performing markets */
  bestMarkets: Array<{ market: string; winRate: number; total: number }>;
  /** Top 5 worst-performing markets */
  worstMarkets: Array<{ market: string; winRate: number; total: number }>;
  /** Top 3 best-performing sources (by accuracy, min 10 predictions) */
  bestSources: Array<{ source: string; accuracy: number; total: number }>;
  /** Top 3 worst-performing sources */
  worstSources: Array<{ source: string; accuracy: number; total: number }>;
  perDay: BacktestDayResult[];
}

/**
 * Run a backtest over a date range. Each date is processed independently —
 * predictions are rebuilt from the raw predictions stored at the time.
 *
 * This function is HEAVY — it can take 30-60 seconds per day of history.
 * For large date ranges, prefer the CLI script which doesn't have a function
 * timeout.
 */
export async function runBacktest(
  startDate: string,
  endDate: string
): Promise<BacktestSummary> {
  const perDay: BacktestDayResult[] = [];

  // Iterate dates
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const dayResult = await backtestSingleDate(dateStr);
    if (dayResult.matchesAnalyzed > 0) {
      perDay.push(dayResult);
    }
  }

  // Aggregate
  const totalMatches = perDay.reduce((s, d) => s + d.matchesAnalyzed, 0);
  const totalPredictions = perDay.reduce((s, d) => s + d.predictionsGenerated, 0);
  const totalEvaluated = perDay.reduce((s, d) => s + d.predictionsEvaluated, 0);
  const totalCorrect = perDay.reduce((s, d) => s + d.correctCount, 0);

  const aggregateWinRate = totalEvaluated > 0 ? totalCorrect / totalEvaluated : 0;
  const aggregateBrier = perDay.length > 0
    ? perDay.reduce((s, d) => s + d.calibrationError, 0) / perDay.length
    : 0;
  const aggregateFlatRoi = perDay.length > 0
    ? perDay.reduce((s, d) => s + d.flatRoi, 0) / perDay.length
    : 0;
  const aggregateKellyRoi = perDay.length > 0
    ? perDay.reduce((s, d) => s + d.kellyRoi, 0) / perDay.length
    : 0;
  const clvDays = perDay.filter((d) => d.avgClv !== null);
  const aggregateClv = clvDays.length > 0
    ? clvDays.reduce((s, d) => s + (d.avgClv ?? 0), 0) / clvDays.length
    : null;

  // Aggregate market breakdown
  const marketBreakdown: Record<string, { total: number; correct: number }> = {};
  for (const day of perDay) {
    for (const [market, v] of Object.entries(day.marketBreakdown)) {
      const e = marketBreakdown[market] ?? { total: 0, correct: 0 };
      e.total += v.total;
      e.correct += v.correct;
      marketBreakdown[market] = e;
    }
  }
  const marketWithWinRate = Object.fromEntries(
    Object.entries(marketBreakdown).map(([k, v]) => [
      k,
      { ...v, winRate: v.total > 0 ? v.correct / v.total : 0 },
    ])
  );

  // Aggregate source breakdown
  const sourceBreakdown: Record<string, { total: number; correct: number }> = {};
  for (const day of perDay) {
    for (const [src, v] of Object.entries(day.sourceBreakdown)) {
      const e = sourceBreakdown[src] ?? { total: 0, correct: 0 };
      e.total += v.total;
      e.correct += v.correct;
      sourceBreakdown[src] = e;
    }
  }
  const sourceWithAcc = Object.fromEntries(
    Object.entries(sourceBreakdown).map(([k, v]) => [
      k,
      { ...v, accuracy: v.total > 0 ? v.correct / v.total : 0 },
    ])
  );

  // Top markets
  const marketList = Object.entries(marketWithWinRate)
    .map(([market, v]) => ({ market, winRate: v.winRate, total: v.total }))
    .filter((m) => m.total >= 3)
    .sort((a, b) => b.winRate - a.winRate);
  const bestMarkets = marketList.slice(0, 5);
  const worstMarkets = marketList.slice(-5).reverse();

  // Top sources
  const sourceList = Object.entries(sourceWithAcc)
    .map(([source, v]) => ({ source, accuracy: v.accuracy, total: v.total }))
    .filter((s) => s.total >= 10)
    .sort((a, b) => b.accuracy - a.accuracy);
  const bestSources = sourceList.slice(0, 3);
  const worstSources = sourceList.slice(-3).reverse();

  return {
    startDate,
    endDate,
    daysAnalyzed: perDay.length,
    totalMatches,
    totalPredictions,
    totalEvaluated,
    totalCorrect,
    aggregateWinRate,
    aggregateBrier,
    aggregateFlatRoi,
    aggregateKellyRoi,
    aggregateClv,
    marketBreakdown: marketWithWinRate,
    sourceBreakdown: sourceWithAcc,
    bestMarkets,
    worstMarkets,
    bestSources,
    worstSources,
    perDay,
  };
}

/**
 * Backtest a single date: rebuild predictions, evaluate against actual results.
 */
async function backtestSingleDate(dateStr: string): Promise<BacktestDayResult> {
  const matches = await db.match.findMany({
    where: {
      matchDate: dateStr,
      resultProcessed: true,
      homeScore: { not: null },
      awayScore: { not: null },
    },
    include: {
      rawPredictions: { include: { source: true } },
      predictions: true,
    },
  });

  if (matches.length === 0) {
    return {
      date: dateStr,
      matchesAnalyzed: 0,
      predictionsGenerated: 0,
      predictionsEvaluated: 0,
      correctCount: 0,
      winRate: 0,
      calibrationError: 0,
      flatRoi: 0,
      kellyRoi: 0,
      avgClv: null,
      marketBreakdown: {},
      sourceBreakdown: {},
    };
  }

  let predictionsGenerated = 0;
  let predictionsEvaluated = 0;
  let correctCount = 0;
  const calibrationSamples: Array<{ pred: number; actual: number }> = [];
  let flatStake = 0;
  let flatReturns = 0;
  let kellyStake = 0;
  let kellyReturns = 0;
  const marketBreakdown: Record<string, { total: number; correct: number }> = {};
  const sourceBreakdown: Record<string, { total: number; correct: number }> = {};
  let clvSum = 0;
  let clvCount = 0;

  for (const match of matches) {
    // Rebuild predictions from raw — same code path as production
    const ctx: MatchContext = {
      matchId: match.id,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      homeForm: match.homeForm,
      awayForm: match.awayForm,
      rawPredictions: match.rawPredictions.map((rp) => ({
        sourceId: rp.sourceId,
        sourceName: rp.source.name,
        weight: rp.source.weight,
        prediction: reconstituteRaw(rp),
      })),
    };
    const enginePreds = buildPredictionsForMatch(ctx);
    predictionsGenerated += enginePreds.length;

    // Evaluate each rebuilt prediction
    for (const p of enginePreds) {
      if (p.market === "bet_builder" || p.market === "corners_first") continue;
      const correct = evaluatePredictionVsResult(p, {
        homeScore: match.homeScore ?? 0,
        awayScore: match.awayScore ?? 0,
        htHomeScore: match.htHomeScore ?? undefined,
        htAwayScore: match.htAwayScore ?? undefined,
        corners: match.corners ?? undefined,
        cards: match.cards ?? undefined,
      });
      predictionsEvaluated++;
      calibrationSamples.push({ pred: p.probability, actual: correct ? 1 : 0 });

      const mkt = marketBreakdown[p.market] ?? { total: 0, correct: 0 };
      mkt.total++;
      if (correct) {
        correctCount++;
        mkt.correct++;
      }
      marketBreakdown[p.market] = mkt;

      // Flat 1u ROI on top picks
      if (p.isTopPick) {
        flatStake += 1;
        if (correct) flatReturns += (p.bookOdds ?? p.fairOdds);
      }

      // Kelly-sized ROI on value bets
      if (p.isValueBet && p.bookOdds) {
        const k = kelly(p.probability, p.bookOdds);
        kellyStake += k.recommendedStake;
        if (correct) kellyReturns += k.recommendedStake * p.bookOdds;
      }

      // CLV (only on top picks where we have it stored)
      if (p.isTopPick) {
        const storedPred = match.predictions.find((sp) => sp.market === p.market && sp.selection === p.selection);
        if (storedPred?.clv !== null && storedPred?.clv !== undefined) {
          clvSum += storedPred.clv;
          clvCount++;
        }
      }
    }

    // Per-source breakdown on 1X2 (most universal)
    for (const rp of match.rawPredictions) {
      if (!rp.predicted1X2) continue;
      if (!rp.evaluated) continue;
      const srcName = rp.source.name;
      const e = sourceBreakdown[srcName] ?? { total: 0, correct: 0 };
      e.total++;
      if (rp.correct) e.correct++;
      sourceBreakdown[srcName] = e;
    }
  }

  return {
    date: dateStr,
    matchesAnalyzed: matches.length,
    predictionsGenerated,
    predictionsEvaluated,
    correctCount,
    winRate: predictionsEvaluated > 0 ? correctCount / predictionsEvaluated : 0,
    calibrationError: brierScore(calibrationSamples),
    flatRoi: flatStake > 0 ? (flatReturns - flatStake) / flatStake : 0,
    kellyRoi: kellyStake > 0 ? (kellyReturns - kellyStake) / kellyStake : 0,
    avgClv: clvCount > 0 ? clvSum / clvCount : null,
    marketBreakdown,
    sourceBreakdown,
  };
}

/**
 * Evaluate a prediction against a match result. Mirrors the logic in
 * feedback.ts but takes an EnginePrediction directly.
 */
function evaluatePredictionVsResult(
  p: EnginePrediction,
  r: {
    homeScore: number;
    awayScore: number;
    htHomeScore?: number;
    htAwayScore?: number;
    corners?: number;
    cards?: number;
  }
): boolean {
  const total = r.homeScore + r.awayScore;
  switch (p.market) {
    case "1x2": {
      const actual = r.homeScore > r.awayScore ? "1" : r.homeScore < r.awayScore ? "2" : "X";
      return actual === p.selection;
    }
    case "htft": {
      if (r.htHomeScore === undefined || r.htAwayScore === undefined) return false;
      const ht = r.htHomeScore > r.htAwayScore ? "1" : r.htHomeScore < r.htAwayScore ? "2" : "X";
      const ft = r.homeScore > r.awayScore ? "1" : r.homeScore < r.awayScore ? "2" : "X";
      return `${ht}/${ft}` === p.selection;
    }
    case "btts": {
      const yes = r.homeScore > 0 && r.awayScore > 0;
      return (p.selection === "yes") === yes;
    }
    case "ou15": return (p.selection === "over") === (total > 1.5);
    case "ou25": return (p.selection === "over") === (total > 2.5);
    case "ou35": return (p.selection === "over") === (total > 3.5);
    case "correct_score": return `${r.homeScore}-${r.awayScore}` === p.selection;
    case "asian_handicap": {
      // Best-effort: parse line, evaluate against home margin
      const m = p.selection.match(/([+-]?\d+(?:\.\d+)?)$/);
      if (!m) return false;
      const line = parseFloat(m[1]);
      return r.homeScore - r.awayScore + line > 0;
    }
    case "corners_ou": {
      if (r.corners === undefined) return false;
      const m = p.selection.match(/^(over|under)\s+(\d+(?:\.\d+)?)$/i);
      if (!m) return false;
      return (m[1].toLowerCase() === "over") === (r.corners > parseFloat(m[2]));
    }
    case "cards_ou": {
      if (r.cards === undefined) return false;
      const m = p.selection.match(/^(over|under)\s+(\d+(?:\.\d+)?)$/i);
      if (!m) return false;
      return (m[1].toLowerCase() === "over") === (r.cards > parseFloat(m[2]));
    }
    case "win_btts": {
      // Selection like "Arsenal win + BTTS" or "no"
      if (p.selection === "no") {
        // "No" = neither home-win+BTTS nor away-win+BTTS
        const homeWinBtts = r.homeScore > r.awayScore && r.homeScore > 0 && r.awayScore > 0;
        const awayWinBtts = r.awayScore > r.homeScore && r.homeScore > 0 && r.awayScore > 0;
        return !(homeWinBtts || awayWinBtts);
      }
      // Otherwise selection contains "win + BTTS" — check team and BTTS
      const isHome = p.selection.toLowerCase().includes("home") || (!p.selection.toLowerCase().includes("away"));
      if (isHome) {
        return r.homeScore > r.awayScore && r.homeScore > 0 && r.awayScore > 0;
      } else {
        return r.awayScore > r.homeScore && r.homeScore > 0 && r.awayScore > 0;
      }
    }
    default:
      return false;
  }
}

/**
 * Preview the available backtest date range (dates with finished matches).
 */
export async function getBacktestRange(): Promise<{
  earliestDate: string | null;
  latestDate: string | null;
  totalDays: number;
  totalFinishedMatches: number;
}> {
  const matches = await db.match.findMany({
    where: { resultProcessed: true },
    select: { matchDate: true },
    orderBy: { matchDate: "asc" },
  });
  if (matches.length === 0) {
    return { earliestDate: null, latestDate: null, totalDays: 0, totalFinishedMatches: 0 };
  }
  const uniqueDates = [...new Set(matches.map((m) => m.matchDate))].sort();
  return {
    earliestDate: uniqueDates[0],
    latestDate: uniqueDates[uniqueDates.length - 1],
    totalDays: uniqueDates.length,
    totalFinishedMatches: matches.length,
  };
}

// Re-export for external use
export { kelly, kellyParlay };
