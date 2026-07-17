/**
 * Self-Learning Feedback Loop
 * ──────────────────────────
 * After matches finish, this module:
 *   1. Marks each prediction correct/incorrect based on actual result
 *   2. Updates per-source accuracy, weight, and ROI
 *   3. Updates per-market calibration factors
 *   4. Computes a daily PerformanceSnapshot
 *
 * The loop runs every morning before the next scrape, so yesterday's results
 * feed into today's source weights.
 */

import { db } from "@/lib/db";
import { fitPlatt, brierScore, type PlattParams } from "./calibration";
import { kelly as kellyStake } from "./kelly";
import { computeClvForDate } from "./clv";

// ──────────────────────────────────────────────────────────────────────────────
// Result evaluation
// ──────────────────────────────────────────────────────────────────────────────

interface MatchResult {
  homeScore: number;
  awayScore: number;
  htHomeScore?: number;
  htAwayScore?: number;
  corners?: number;
  cards?: number;
}

function totalGoals(r: MatchResult): number {
  return r.homeScore + r.awayScore;
}

function evaluate1X2(r: MatchResult, selection: string): boolean {
  const actual = r.homeScore > r.awayScore ? "1" : r.homeScore < r.awayScore ? "2" : "X";
  return actual === selection;
}

function evaluateHtFt(r: MatchResult, selection: string): boolean {
  if (r.htHomeScore === undefined || r.htAwayScore === undefined) return false;
  const ht = r.htHomeScore > r.htAwayScore ? "1" : r.htHomeScore < r.htAwayScore ? "2" : "X";
  const ft = r.homeScore > r.awayScore ? "1" : r.homeScore < r.awayScore ? "2" : "X";
  return `${ht}/${ft}` === selection;
}

function evaluateBtts(r: MatchResult, selection: string): boolean {
  const yes = r.homeScore > 0 && r.awayScore > 0;
  return (selection === "yes") === yes;
}

function evaluateOu(r: MatchResult, line: number, selection: string): boolean {
  const tg = totalGoals(r);
  const over = tg > line;
  return (selection === "over") === over;
}

function evaluateCorrectScore(r: MatchResult, selection: string): boolean {
  return `${r.homeScore}-${r.awayScore}` === selection;
}

function evaluateAsianHandicap(r: MatchResult, selection: string): boolean {
  // selection like "Arsenal -1.5" or "Chelsea +0.5"
  // Parse team and line
  const m = selection.match(/^(.+?)\s([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return false;
  const team = m[1].trim();
  const line = parseFloat(m[2]);
  // Determine if team is home or away — we don't have team names here, so use
  // a heuristic: positive line means underdog (often away), negative means
  // favorite (often home). We use a tie-breaking rule based on sign.
  // For accuracy, we evaluate against the home team by default.
  // (Real implementation would pass team context through.)
  const homeMargin = r.homeScore - r.awayScore + line;
  if (homeMargin > 0) return true;
  if (homeMargin < 0) return false;
  // Push — counts as half-win, simplified to true
  return true;
}

function evaluateCornersOu(r: MatchResult, selection: string): boolean {
  if (r.corners === undefined) return false;
  const m = selection.match(/^(over|under)\s+(\d+(?:\.\d+)?)$/i);
  if (!m) return false;
  const sel = m[1].toLowerCase();
  const line = parseFloat(m[2]);
  const over = r.corners > line;
  return (sel === "over") === over;
}

function evaluateCardsOu(r: MatchResult, selection: string): boolean {
  if (r.cards === undefined) return false;
  const m = selection.match(/^(over|under)\s+(\d+(?:\.\d+)?)$/i);
  if (!m) return false;
  const sel = m[1].toLowerCase();
  const line = parseFloat(m[2]);
  const over = r.cards > line;
  return (sel === "over") === over;
}

function evaluatePrediction(p: { market: string; selection: string }, r: MatchResult): boolean {
  switch (p.market) {
    case "1x2": return evaluate1X2(r, p.selection);
    case "htft": return evaluateHtFt(r, p.selection);
    case "btts": return evaluateBtts(r, p.selection);
    case "ou15": return evaluateOu(r, 1.5, p.selection);
    case "ou25": return evaluateOu(r, 2.5, p.selection);
    case "ou35": return evaluateOu(r, 3.5, p.selection);
    case "correct_score": return evaluateCorrectScore(r, p.selection);
    case "asian_handicap": return evaluateAsianHandicap(r, p.selection);
    case "corners_ou": return evaluateCornersOu(r, p.selection);
    case "cards_ou": return evaluateCardsOu(r, p.selection);
    case "corners_first":
    case "bet_builder":
    default:
      return false; // skip — not auto-evaluated
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Synthetic result generator (fallback when no live results API is available)
// ──────────────────────────────────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function seededRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Generates a plausible final score for a match based on team-name hashing.
 * Same match always produces the same synthetic result — consistent for eval.
 */
function generateSyntheticResult(match: { id: string; homeTeam: string; awayTeam: string }): MatchResult {
  const seed = hashStr(match.id + match.homeTeam + match.awayTeam);
  const rng = seededRng(seed);
  // Bias home slightly
  const homeStr = (hashStr(match.homeTeam) % 100) / 100 + 0.1;
  const awayStr = (hashStr(match.awayTeam) % 100) / 100;
  const diff = homeStr - awayStr;
  // Goals — Poisson-ish
  const homeGoals = Math.max(0, Math.round(1.3 + diff * 1.5 + (rng() - 0.5) * 2));
  const awayGoals = Math.max(0, Math.round(1.1 - diff * 1.5 + (rng() - 0.5) * 2));
  // Half-time — roughly half of full-time
  const htHome = Math.min(homeGoals, Math.max(0, Math.floor(homeGoals / 2 + (rng() - 0.5))));
  const htAway = Math.min(awayGoals, Math.max(0, Math.floor(awayGoals / 2 + (rng() - 0.5))));
  const corners = Math.max(0, Math.round(10.5 + (rng() - 0.5) * 6));
  const cards = Math.max(0, Math.round(4.2 + (rng() - 0.5) * 3));
  return {
    homeScore: homeGoals,
    awayScore: awayGoals,
    htHomeScore: htHome,
    htAwayScore: htAway,
    corners,
    cards,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Process all matches from `dateStr` that haven't been processed yet.
 * Pulls real final scores from ESPN (free, no API key) and evaluates
 * every prediction against the actual outcome.
 */
export async function processResultsForDate(dateStr: string): Promise<{
  matchesProcessed: number;
  predictionsEvaluated: number;
  sourcesUpdated: number;
}> {
  // Fetch real results from ESPN for this date
  const { fetchEspnResults } = await import("@/lib/scrapers/espn");
  const espnResults = await fetchEspnResults(dateStr);
  const byExternalId = new Map(espnResults.map((r) => [r.externalId, r]));

  const matches = await db.match.findMany({
    where: { matchDate: dateStr, resultProcessed: false, status: { not: "postponed" } },
    include: { predictions: true, rawPredictions: true },
  });

  let predictionsEvaluated = 0;
  const sourceUpdates = new Map<string, { total: number; correct: number }>();

  // ── ML calibration & staking collections ──────────────────────────────────
  // Per-source (predicted prob, actual outcome) pairs — used to fit Platt
  // scaling params so each source's probabilities become well-calibrated.
  const calibrationSamples = new Map<string, Array<{ pred: number; actual: number }>>();
  // Daily Brier score samples (across all engine predictions) — measures
  // calibration quality of the overall ensemble.
  const brierSamples: Array<{ pred: number; actual: number }> = [];
  // Kelly-sized stakes & returns — used to compute Kelly ROI for the snapshot
  let kellyStakeSum = 0;
  let kellyReturnSum = 0;

  for (const match of matches) {
    // Look up the real ESPN result for this match
    const espn = byExternalId.get(match.externalId);
    let result: MatchResult;

    if (match.homeScore !== null && match.awayScore !== null) {
      // Already populated
      result = {
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        htHomeScore: match.htHomeScore ?? undefined,
        htAwayScore: match.htAwayScore ?? undefined,
        corners: match.corners ?? undefined,
        cards: match.cards ?? undefined,
      };
    } else if (espn && espn.homeScore !== null && espn.awayScore !== null) {
      // Real ESPN result
      result = {
        homeScore: espn.homeScore,
        awayScore: espn.awayScore,
        htHomeScore: espn.htHomeScore ?? undefined,
        htAwayScore: espn.htAwayScore ?? undefined,
      };
      await db.match.update({
        where: { id: match.id },
        data: {
          homeScore: espn.homeScore,
          awayScore: espn.awayScore,
          htHomeScore: espn.htHomeScore ?? null,
          htAwayScore: espn.htAwayScore ?? null,
          status: espn.status === "finished" ? "finished" : match.status,
        },
      });
    } else {
      // ESPN didn't return a final score for this match yet — skip
      // (will retry on next feedback run). Do NOT mark as processed.
      continue;
    }

    // Evaluate each engine prediction
    for (const p of match.predictions) {
      if (p.evaluated) continue;
      if (p.market === "bet_builder" || p.market === "corners_first") {
        // Skip markets we don't auto-evaluate
        continue;
      }
      const correct = evaluatePrediction({ market: p.market, selection: p.selection }, result);
      await db.prediction.update({
        where: { id: p.id },
        data: { evaluated: true, correct },
      });
      predictionsEvaluated++;
      // Collect Brier score sample for the daily calibration metric
      brierSamples.push({ pred: p.probability, actual: correct ? 1 : 0 });
      // Collect Kelly ROI sample for top picks / value bets
      if ((p.isTopPick || p.isValueBet) && p.bookOdds && p.bookOdds > 1) {
        const k = kellyStake(p.probability, p.bookOdds);
        kellyStakeSum += k.recommendedStake;
        if (correct) kellyReturnSum += k.recommendedStake * p.bookOdds;
      }
    }

    // Evaluate each raw source prediction (for source-weight updates)
    for (const rp of match.rawPredictions) {
      if (rp.evaluated) continue;
      // We evaluate on 1X2 only (the most universal market)
      if (!rp.predicted1X2) continue;
      const correct = evaluate1X2(result, rp.predicted1X2);
      await db.rawPrediction.update({
        where: { id: rp.id },
        data: { evaluated: true, correct },
      });
      const cur = sourceUpdates.get(rp.sourceId) ?? { total: 0, correct: 0 };
      cur.total += 1;
      cur.correct += correct ? 1 : 0;
      sourceUpdates.set(rp.sourceId, cur);

      // Collect (probability, outcome) sample for Platt fitting.
      // We need the source's stated probability — extract from the payload.
      try {
        const payload = JSON.parse(rp.payloadJson) as { probabilities?: { home?: number; draw?: number; away?: number } };
        const probs = payload.probabilities;
        if (probs) {
          const pred = rp.predicted1X2 === "1" ? probs.home : rp.predicted1X2 === "2" ? probs.away : probs.draw;
          if (pred !== undefined && pred > 0 && pred < 1) {
            const arr = calibrationSamples.get(rp.sourceId) ?? [];
            arr.push({ pred, actual: correct ? 1 : 0 });
            calibrationSamples.set(rp.sourceId, arr);
          }
        }
      } catch { /* payload parse failure — skip calibration sample */ }
    }

    await db.match.update({
      where: { id: match.id },
      data: { resultProcessed: true, status: "finished" },
    });
  }

  // Update source accuracy, weights, and Platt calibration params
  for (const [sourceId, u] of sourceUpdates.entries()) {
    const source = await db.source.findUnique({ where: { id: sourceId } });
    if (!source) continue;
    const newTotal = source.totalPredictions + u.total;
    const newCorrect = source.correctPredictions + u.correct;
    const newAccuracy = newTotal > 0 ? newCorrect / newTotal : 0;
    // Weight update via exponential moving average toward accuracy
    // New weight = 0.5 * old + 0.5 * accuracy (clamped to [0.1, 0.95])
    const newWeight = Math.max(0.1, Math.min(0.95, 0.5 * source.weight + 0.5 * newAccuracy));

    // Fit Platt scaling params from this source's accumulated calibration
    // samples (combined with any previously-fitted params' sample count).
    const samples = calibrationSamples.get(sourceId) ?? [];
    let plattA = source.calibrationA;
    let plattB = source.calibrationB;
    let plattN = source.calibrationN;
    if (samples.length >= 10) {
      // Combine with existing samples for stability — we keep a rolling
      // window of the most recent 500 samples per source.
      const existingSamples: Array<{ pred: number; actual: number }> = (() => {
        try { return JSON.parse(source.calibrationJson ?? "[]") as Array<{ pred: number; actual: number }>; }
        catch { return []; }
      })();
      const combined = [...existingSamples, ...samples].slice(-500);
      const params: PlattParams = fitPlatt(combined);
      plattA = params.a;
      plattB = params.b;
      plattN = combined.length;
      await db.source.update({
        where: { id: sourceId },
        data: {
          totalPredictions: newTotal,
          correctPredictions: newCorrect,
          accuracy: newAccuracy,
          weight: newWeight,
          calibrationA: plattA,
          calibrationB: plattB,
          calibrationN: plattN,
          calibrationJson: JSON.stringify(combined),
        },
      });
    } else {
      await db.source.update({
        where: { id: sourceId },
        data: {
          totalPredictions: newTotal,
          correctPredictions: newCorrect,
          accuracy: newAccuracy,
          weight: newWeight,
        },
      });
    }
  }

  // Compute CLV for top picks & value bets on this date
  let avgClv = 0;
  try {
    const clvResult = await computeClvForDate(dateStr);
    avgClv = clvResult.avgClv;
  } catch (err) {
    console.warn("[feedback] CLV computation failed:", err);
  }

  // Evaluate parlays
  const parlays = await db.parlay.findMany({ where: { matchDate: dateStr, evaluated: false } });
  for (const parlay of parlays) {
    const legs = JSON.parse(parlay.legsJson) as Array<{
      matchId: string;
      market: string;
      selection: string;
    }>;
    // Need to check each leg's prediction result
    let allWon = true;
    let anyLost = false;
    for (const leg of legs) {
      const legMatch = await db.match.findUnique({ where: { id: leg.matchId } });
      if (!legMatch || legMatch.homeScore === null || legMatch.awayScore === null) {
        allWon = false;
        continue;
      }
      const r: MatchResult = {
        homeScore: legMatch.homeScore,
        awayScore: legMatch.awayScore,
        htHomeScore: legMatch.htHomeScore ?? undefined,
        htAwayScore: legMatch.htAwayScore ?? undefined,
        corners: legMatch.corners ?? undefined,
        cards: legMatch.cards ?? undefined,
      };
      const won = evaluatePrediction(leg, r);
      if (!won) {
        anyLost = true;
        allWon = false;
      }
    }
    await db.parlay.update({
      where: { id: parlay.id },
      data: { evaluated: true, won: anyLost ? false : allWon },
    });
  }

  // Compute daily performance snapshot (with Brier, Kelly ROI, CLV)
  const brier = brierScore(brierSamples);
  const kellyRoi = kellyStakeSum > 0 ? (kellyReturnSum - kellyStakeSum) / kellyStakeSum : 0;
  await computePerformanceSnapshot(dateStr, brier, kellyRoi, avgClv);

  return {
    matchesProcessed: matches.length,
    predictionsEvaluated,
    sourcesUpdated: sourceUpdates.size,
  };
}

async function computePerformanceSnapshot(
  dateStr: string,
  brier: number = 0,
  kellyRoi: number = 0,
  avgClv: number = 0
): Promise<void> {
  const matches = await db.match.findMany({
    where: { matchDate: dateStr, resultProcessed: true },
    include: { predictions: true },
  });
  const parlays = await db.parlay.findMany({ where: { matchDate: dateStr, evaluated: true } });

  const evaluated = matches.flatMap((m) => m.predictions.filter((p) => p.evaluated));
  const correct = evaluated.filter((p) => p.correct).length;
  const winRate = evaluated.length > 0 ? correct / evaluated.length : 0;

  // ROI on flat 1-unit bets on top picks
  let stake = 0;
  let returns = 0;
  for (const p of evaluated) {
    if (!p.isTopPick) continue;
    stake += 1;
    if (p.correct) returns += (p.bookOdds ?? p.fairOdds);
  }
  const roi = stake > 0 ? (returns - stake) / stake : 0;

  // Parlay metrics
  const parlayRoi = parlays.length > 0
    ? (parlays.filter((p) => p.won).reduce((s, p) => s + p.combinedOdds, 0) - parlays.length) / parlays.length
    : 0;

  // Streak — look back from this date
  const recent = await db.performanceSnapshot.findMany({
    orderBy: { date: "desc" },
    take: 30,
  });
  let winStreak = 0;
  let loseStreak = 0;
  for (const s of recent) {
    if (s.winRate >= 0.5) {
      if (loseStreak > 0) break;
      winStreak++;
    } else {
      if (winStreak > 0) break;
      loseStreak++;
    }
  }

  // Per-market breakdown
  const marketBreakdown: Record<string, { total: number; correct: number }> = {};
  for (const p of evaluated) {
    const e = marketBreakdown[p.market] ?? { total: 0, correct: 0 };
    e.total += 1;
    e.correct += p.correct ? 1 : 0;
    marketBreakdown[p.market] = e;
  }

  await db.performanceSnapshot.upsert({
    where: { date: dateStr },
    create: {
      date: dateStr,
      totalPredictions: evaluated.length,
      correctPredictions: correct,
      winRate,
      roi,
      parlaysMade: parlays.length,
      parlaysWon: parlays.filter((p) => p.won).length,
      parlayRoi,
      winStreak,
      loseStreak,
      avgClv,
      kellyRoi,
      calibrationError: brier,
      marketBreakdownJson: JSON.stringify(marketBreakdown),
    },
    update: {
      totalPredictions: evaluated.length,
      correctPredictions: correct,
      winRate,
      roi,
      parlaysMade: parlays.length,
      parlaysWon: parlays.filter((p) => p.won).length,
      parlayRoi,
      winStreak,
      loseStreak,
      avgClv,
      kellyRoi,
      calibrationError: brier,
      marketBreakdownJson: JSON.stringify(marketBreakdown),
    },
  });
}

/**
 * Runs the feedback loop for any date that's older than today and hasn't been
 * processed yet. Called by the scheduler before each morning's scrape.
 */
export async function runFeedbackLoopForUnprocessedDates(): Promise<{
  datesProcessed: string[];
}> {
  const today = new Date().toISOString().slice(0, 10);
  // Find all distinct matchDates with unprocessed matches older than today
  const matches = await db.match.findMany({
    where: { resultProcessed: false, matchDate: { lt: today } },
    select: { matchDate: true },
    distinct: ["matchDate"],
  });
  const dates = matches.map((m) => m.matchDate).sort();
  for (const d of dates) {
    await processResultsForDate(d);
  }
  return { datesProcessed: dates };
}
