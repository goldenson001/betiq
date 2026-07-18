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
import { updateEloRatingsForDate } from "./elo";

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

function evaluateDoubleChance(r: MatchResult, selection: string): boolean {
  const actual = r.homeScore > r.awayScore ? "1" : r.homeScore < r.awayScore ? "2" : "X";
  if (selection === "1X") return actual === "1" || actual === "X";
  if (selection === "X2") return actual === "X" || actual === "2";
  if (selection === "12") return actual === "1" || actual === "2";
  return false;
}

function evaluateDnb(
  r: MatchResult,
  selection: string,
  homeTeam?: string,
  awayTeam?: string
): boolean {
  // Selection like "Arsenal DNB" — win if team wins, push (treated as not-loss)
  // on draw, lose if other team wins. For feedback, push is treated as
  // half-correct — but since we report boolean correct, push counts as "not
  // loss" = true (the stake is refunded, no capital lost).
  const actual = r.homeScore > r.awayScore ? "1" : r.homeScore < r.awayScore ? "2" : "X";
  if (actual === "X") return true; // push = stake returned, treated as "not loss"
  // ── D2 fix: was previously using a "selection contains 'away'" heuristic ──
  // that mis-classified away teams whose name doesn't contain "away" (i.e.,
  // almost all of them). Now we compare the team name extracted from the
  // selection against homeTeam/awayTeam and fall back to the home-by-default
  // heuristic only if team names aren't available.
  const sel = selection.replace(/\s+DNB$/i, "").trim().toLowerCase();
  const home = homeTeam?.toLowerCase();
  const away = awayTeam?.toLowerCase();
  let isHomeDnb: boolean;
  if (home && away) {
    // Match if selection contains the team name (handles "Arsenal DNB", "Arsenal F.C. DNB", etc.)
    if (sel.includes(home)) isHomeDnb = true;
    else if (sel.includes(away)) isHomeDnb = false;
    else {
      // Fallback: can't determine — assume the engine's pick (home side favored)
      isHomeDnb = true;
    }
  } else {
    // No team context — fall back to home-by-default (engine usually picks favorite)
    isHomeDnb = true;
  }
  if (isHomeDnb) return actual === "1";
  return actual === "2";
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

function evaluateAsianHandicap(
  r: MatchResult,
  selection: string,
  homeTeam?: string,
  awayTeam?: string
): boolean {
  // selection like "Arsenal -1.5" or "Chelsea +0.5"
  // Parse team and line
  const m = selection.match(/^(.+?)\s([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return false;
  const team = m[1].trim().toLowerCase();
  const line = parseFloat(m[2]);

  // ── D2 fix: was previously assuming the team is always the home side ──────
  // (using a "positive line = underdog = away" heuristic). This is wrong for
  // any away team pick. Now we compare the team name extracted from the
  // selection against homeTeam/awayTeam and fall back to home-by-default
  // only if team names aren't available.
  let isHome: boolean;
  const home = homeTeam?.toLowerCase();
  const away = awayTeam?.toLowerCase();
  if (home && away) {
    if (team.includes(home) || home.includes(team)) isHome = true;
    else if (team.includes(away) || away.includes(team)) isHome = false;
    else {
      // Fallback: can't determine — assume home (engine usually picks favorite
      // for AH, which is typically home).
      isHome = true;
    }
  } else {
    // No team context — fall back to home-by-default
    isHome = true;
  }

  // Compute the margin from this team's perspective.
  // If home team with line -1.5: homeMargin = homeGoals - awayGoals + line (line is negative)
  // If away team with line +0.5:  awayMargin = awayGoals - homeGoals + line (line is positive)
  const teamGoals = isHome ? r.homeScore : r.awayScore;
  const oppGoals = isHome ? r.awayScore : r.homeScore;
  const margin = teamGoals - oppGoals + line;
  if (margin > 0) return true;
  if (margin < 0) return false;
  // Push — counts as half-win, simplified to true (stake refunded)
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

export function evaluatePrediction(
  p: { market: string; selection: string },
  r: MatchResult,
  homeTeam?: string,
  awayTeam?: string
): boolean {
  switch (p.market) {
    case "1x2": return evaluate1X2(r, p.selection);
    case "double_chance": return evaluateDoubleChance(r, p.selection);
    case "dnb": return evaluateDnb(r, p.selection, homeTeam, awayTeam);
    case "htft": return evaluateHtFt(r, p.selection);
    case "btts": return evaluateBtts(r, p.selection);
    case "ou15": return evaluateOu(r, 1.5, p.selection);
    case "ou25": return evaluateOu(r, 2.5, p.selection);
    case "ou35": return evaluateOu(r, 3.5, p.selection);
    case "correct_score": return evaluateCorrectScore(r, p.selection);
    case "asian_handicap": return evaluateAsianHandicap(r, p.selection, homeTeam, awayTeam);
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
  // Per-(source, league) samples — used to fit per-league Platt params.
  // Key: `${sourceId}|${leagueId}`. Falls back to global if league is null.
  const leagueCalibrationSamples = new Map<string, Array<{ pred: number; actual: number }>>();
  // Per-source Brier samples for rolling 30-day reliability metric.
  const sourceBrierSamples = new Map<string, Array<{ pred: number; actual: number }>>();
  // Per-source CLV samples for rolling 30-day metric.
  const sourceClvSamples = new Map<string, number[]>();
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
      const correct = evaluatePrediction(
        { market: p.market, selection: p.selection },
        result,
        match.homeTeam,
        match.awayTeam
      );
      await db.prediction.update({
        where: { id: p.id },
        data: { evaluated: true, correct },
      });
      predictionsEvaluated++;
      // Collect Brier score sample for the daily calibration metric
      brierSamples.push({ pred: p.probability, actual: correct ? 1 : 0 });
      // Collect Kelly ROI sample for top picks / value bets / safe high-odds picks
      if ((p.isTopPick || p.isValueBet || p.isSafeHighOdds) && p.bookOdds && p.bookOdds > 1) {
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
            const sample = { pred, actual: correct ? 1 : 0 };
            // Global source calibration
            const arr = calibrationSamples.get(rp.sourceId) ?? [];
            arr.push(sample);
            calibrationSamples.set(rp.sourceId, arr);
            // Per-(source, league) calibration
            if (match.leagueId) {
              const key = `${rp.sourceId}|${match.leagueId}`;
              const larr = leagueCalibrationSamples.get(key) ?? [];
              larr.push(sample);
              leagueCalibrationSamples.set(key, larr);
            }
            // Per-source rolling Brier samples
            const barr = sourceBrierSamples.get(rp.sourceId) ?? [];
            barr.push(sample);
            sourceBrierSamples.set(rp.sourceId, barr);
          }
        }
      } catch { /* payload parse failure — skip calibration sample */ }
    }

    // ── Per-source CLV sample collection ──────────────────────────────────────
    // For each top pick / value bet / safe high-odds pick on this match, if we
    // have CLV computed, attribute it to the contributing sources (from
    // sourcesJson).
    for (const p of match.predictions) {
      if (!p.evaluated || p.clv === null || p.clv === undefined) continue;
      if (!p.isTopPick && !p.isValueBet && !p.isSafeHighOdds) continue;
      try {
        const srcs = JSON.parse(p.sourcesJson ?? "[]") as Array<{ source?: string }>;
        // Look up source IDs from source name (we stored names in sourcesJson)
        for (const s of srcs) {
          if (!s.source) continue;
          const src = await db.source.findUnique({ where: { name: s.source } });
          if (!src) continue;
          const arr = sourceClvSamples.get(src.id) ?? [];
          arr.push(p.clv);
          sourceClvSamples.set(src.id, arr);
        }
      } catch { /* ignore parse errors */ }
    }

    await db.match.update({
      where: { id: match.id },
      data: { resultProcessed: true, status: "finished" },
    });
  }

  // Update source accuracy, weights, Platt calibration params, AND rolling
  // reliability metrics (Brier, CLV) for source weighting.
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
    }

    // ── Rolling Brier (30-day window) ────────────────────────────────────────
    // Compute from today's samples (already in sourceBrierSamples).
    const brierSamplesToday = sourceBrierSamples.get(sourceId) ?? [];
    const brier30d = brierSamplesToday.length > 0
      ? brierScore(brierSamplesToday)
      : source.brier30d; // no new data — keep previous

    // ── Rolling CLV (today's average) ────────────────────────────────────────
    const clvToday = sourceClvSamples.get(sourceId) ?? [];
    const clv30d = clvToday.length > 0
      ? clvToday.reduce((s, x) => s + x, 0) / clvToday.length
      : source.clv30d;

    const recentSamples = source.recentSamples + brierSamplesToday.length;

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
        calibrationJson: samples.length >= 10
          ? JSON.stringify([...(JSON.parse(source.calibrationJson ?? "[]") as Array<{ pred: number; actual: number }>), ...samples].slice(-500))
          : source.calibrationJson,
        brier30d,
        clv30d,
        recentSamples,
      },
    });
  }

  // ── Per-league Platt calibration fitting ───────────────────────────────────
  // For each (sourceId, leagueId) we collected samples for, fit Platt params
  // and upsert into SourceLeagueCalibration. We keep a rolling window of 200
  // samples per (source, league) pair — smaller than the global 500 because
  // per-league samples are sparser.
  for (const [key, samples] of leagueCalibrationSamples.entries()) {
    const [sourceId, leagueId] = key.split("|");
    if (!sourceId || !leagueId) continue;
    if (samples.length < 5) continue; // need at least a few samples to bother
    // Load existing row (if any) to combine samples
    const existing = await db.sourceLeagueCalibration.findUnique({
      where: { sourceId_leagueId: { sourceId, leagueId } },
    });
    const existingSamples: Array<{ pred: number; actual: number }> = (() => {
      try { return JSON.parse(existing?.samplesJson ?? "[]") as Array<{ pred: number; actual: number }>; }
      catch { return []; }
    })();
    const combined = [...existingSamples, ...samples].slice(-200);
    if (combined.length < 10) continue; // not enough to fit reliably
    const params = fitPlatt(combined);
    await db.sourceLeagueCalibration.upsert({
      where: { sourceId_leagueId: { sourceId, leagueId } },
      create: {
        sourceId,
        leagueId,
        calibrationA: params.a,
        calibrationB: params.b,
        sampleCount: combined.length,
        samplesJson: JSON.stringify(combined),
      },
      update: {
        calibrationA: params.a,
        calibrationB: params.b,
        sampleCount: combined.length,
        samplesJson: JSON.stringify(combined),
      },
    });
  }

  // Compute CLV for top picks & value bets on this date
  let avgClv = 0;
  try {
    const clvResult = await computeClvForDate(dateStr);
    avgClv = clvResult.avgClv;
  } catch (err) {
    console.warn("[feedback] CLV computation failed:", err);
  }

  // ── B3: Update per-(market, league) rolling CLV ───────────────────────────
  // For each prediction on this date with CLV computed, attribute it to its
  // (market, league) pair. Used by the engine to EXCLUDE investment-grade
  // picks on combos where we systematically lose to the closing line.
  try {
    await updateMarketLeagueClv(dateStr);
  } catch (err) {
    console.warn("[feedback] MarketLeagueClv update failed:", err);
  }

  // ── A2: Update Elo team ratings for finished matches ──────────────────────
  try {
    await updateEloRatingsForDate(dateStr);
  } catch (err) {
    console.warn("[feedback] Elo update failed:", err);
  }

  // Evaluate parlays
  const parlays = await db.parlay.findMany({ where: { matchDate: dateStr, evaluated: false } });
  // Collect settlement outcomes as we evaluate each parlay — we'll pass
  // these to the stake ledger so it can settle the corresponding stake rows
  // (computing actual return + realized ROI).
  const settlementOutcomes: Array<{ parlayId: string; won: boolean; legsWon: number; legsLost: number; legsVoid: number }> = [];
  for (const parlay of parlays) {
    const legs = JSON.parse(parlay.legsJson) as Array<{
      matchId: string;
      market: string;
      selection: string;
    }>;
    // Need to check each leg's prediction result
    let allWon = true;
    let anyLost = false;
    let pendingLegs = 0;
    let legsWon = 0;
    let legsVoid = 0;
    for (const leg of legs) {
      const legMatch = await db.match.findUnique({ where: { id: leg.matchId } });
      // ── Don't settle a parlay until ALL legs have final scores ──────────
      // If any leg's match hasn't finished yet, leave the parlay
      // `evaluated: false` so we retry on the next pipeline run.
      // Previously this code marked the parlay as `evaluated: true, won: false`
      // on the first partial pass, which (a) was wrong (could still win) and
      // (b) never got re-evaluated once the remaining legs finished.
      if (!legMatch || legMatch.homeScore === null || legMatch.awayScore === null) {
        pendingLegs++;
        continue;
      }
      // Void detection — postponed / abandoned matches get status "postponed"
      // or "abandoned". We treat these legs as void (refunded), not losses.
      if (legMatch.status === "postponed" || legMatch.status === "abandoned" || legMatch.status === "void") {
        legsVoid++;
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
      const won = evaluatePrediction(leg, r, legMatch.homeTeam, legMatch.awayTeam);
      if (won) {
        legsWon++;
      } else {
        anyLost = true;
        allWon = false;
      }
    }
    // If any leg is still pending (match not finished), skip settlement entirely.
    // The parlay stays `evaluated: false` and will be retried on the next run
    // once ESPN posts the final score for the missing match(es).
    if (pendingLegs > 0 && !anyLost) {
      // Edge case: if we already KNOW a leg lost, we could mark it lost now.
      // But to keep semantics simple and audit-friendly, we wait until all
      // legs are settled so the `won` flag is final, not provisional.
      continue;
    }
    const legsLost = legs.length - legsWon - legsVoid;
    // A parlay "won" only if ALL non-void legs won AND there was at least one
    // non-void leg. If all legs voided, the parlay is void (refunded).
    const parlayWon = legsVoid === legs.length
      ? false // all-void → treat as void (not won, not lost — ledger will refund)
      : !anyLost && allWon && legsWon > 0;
    await db.parlay.update({
      where: { id: parlay.id },
      data: { evaluated: true, won: parlayWon },
    });

    // Track settlement outcome for the stake ledger
    settlementOutcomes.push({
      parlayId: parlay.id,
      won: parlayWon,
      legsWon,
      legsLost,
      legsVoid,
    });

    // ── ML: update per-tier historical stats so the next parlay build can ──
    // use Bayesian shrinkage with this observed result. This is the
    // self-learning loop: every settled parlay feeds back into the tier's
    // rolling win rate, which then adjusts the next parlay's combined
    // probability + Kelly stake.
    try {
      const { updateParlayTierStats } = await import("./parlay-ml");
      await updateParlayTierStats(
        parlay.type,
        parlayWon,
        legs.length,
        legsWon,
        parlay.combinedProbability,
        dateStr
      );
    } catch (err) {
      console.warn("[feedback] ParlayTierStats update failed:", err);
    }
  }

  // ── Settle stake ledger rows + update bankroll snapshot ────────────────────
  // After all parlays for this date have been evaluated, we:
  //   1. Settle the corresponding StakeLedger rows (compute actualReturn +
  //      realizedRoi based on the parlay outcome).
  //   2. Settle the corresponding PickAudit rows (backfill won/lost/return
  //      so audit records carry complete lifecycle data).
  //   3. Snapshot the bankroll — computes today's P&L, updates bankroll +
  //      peak + drawdown state, persists a BankrollSnapshot row.
  //
  // These three steps make the system end-to-end auditable: every
  // recommendation → placement → settlement → bankroll impact is recorded.
  if (settlementOutcomes.length > 0) {
    try {
      const { settleStakesForDate } = await import("@/lib/audit/stake-ledger");
      await settleStakesForDate(dateStr, settlementOutcomes);
    } catch (err) {
      console.warn("[feedback] StakeLedger settlement failed:", err);
    }

    // Backfill PickAudit rows with settlement outcomes.
    try {
      const { settlePickAudit } = await import("@/lib/audit/pick-audit");
      for (const outcome of settlementOutcomes) {
        // Need actualReturn + realizedRoi for the audit row. We reconstruct
        // from the stake ledger (which already has the monetary values).
        // For simplicity, we just mark won/legsWon/legsLost/legsVoid here —
        // the stake ledger is the source of truth for monetary values.
        await settlePickAudit(outcome.parlayId, {
          won: outcome.won,
          legsWon: outcome.legsWon,
          legsLost: outcome.legsLost,
          legsVoid: outcome.legsVoid,
          actualReturn: 0, // populated below from stake ledger if available
          realizedRoi: 0,
        }).catch(() => { /* non-fatal — audit row may not exist */ });

        // Best-effort: copy actualReturn + realizedRoi from stake ledger
        try {
          const stake = await db.stakeLedger.findFirst({
            where: { parlayId: outcome.parlayId },
            orderBy: { createdAt: "desc" },
            select: { actualReturn: true, realizedRoi: true, stakeAmount: true },
          });
          if (stake && (stake.actualReturn !== null || stake.realizedRoi !== null)) {
            await db.pickAudit.updateMany({
              where: { parlayId: outcome.parlayId, settledAt: { not: null } },
              data: {
                actualReturn: stake.actualReturn,
                realizedRoi: stake.realizedRoi,
              },
            });
          }
        } catch {
          // non-fatal — best-effort enrichment
        }
      }
    } catch (err) {
      console.warn("[feedback] PickAudit settlement failed:", err);
    }
  }

  // ── Bankroll snapshot — always run, even if no parlays settled today ──────
  // This captures the day's P&L (0 if nothing settled) and updates streaks +
  // drawdown state. Idempotent — safe to call multiple times per date.
  try {
    const { snapshotBankroll } = await import("@/lib/audit/bankroll");
    await snapshotBankroll(dateStr);
  } catch (err) {
    console.warn("[feedback] BankrollSnapshot failed:", err);
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
 * Runs the feedback loop for any date <= today that has unprocessed matches.
 * Called by the scheduler before each morning's scrape and after every
 * pipeline run. Same-day early kickoffs (e.g. 14:00 Brussels) settle the
 * same day once ESPN posts final scores, rather than waiting 24h.
 */
export async function runFeedbackLoopForUnprocessedDates(): Promise<{
  datesProcessed: string[];
}> {
  // ── Include today in the date window ─────────────────────────────────────
  // Previously this used `matchDate: { lt: today }`, which meant a match that
  // kicked off at 14:00 Brussels and finished by 16:00 wouldn't have its
  // result processed until the next day's pipeline run. That delayed parlay
  // settlement by ~24h for early kickoffs.
  //
  // We now include today. The per-match check inside processResultsForDate
  // already handles the "match hasn't finished yet" case gracefully — it just
  // skips that match and leaves `resultProcessed: false` for the next run.
  const today = new Date().toISOString().slice(0, 10);
  const matches = await db.match.findMany({
    where: { resultProcessed: false, matchDate: { lte: today } },
    select: { matchDate: true },
    distinct: ["matchDate"],
  });
  const dates = matches.map((m) => m.matchDate).sort();
  for (const d of dates) {
    await processResultsForDate(d);
  }
  return { datesProcessed: dates };
}

// ──────────────────────────────────────────────────────────────────────────────
// B3: Per-(market, league) rolling CLV
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Update the MarketLeagueClv table with CLV samples from a given date.
 *
 * For each prediction on this date with CLV computed, attribute the CLV to
 * its (market, league) pair. We keep a rolling window of 30 samples per pair
 * and recompute the average.
 *
 * This is used by the engine to EXCLUDE investment-grade picks on combos
 * where we systematically lose to the closing line.
 */
async function updateMarketLeagueClv(dateStr: string): Promise<void> {
  const preds = await db.prediction.findMany({
    where: {
      match: { matchDate: dateStr },
      clv: { not: null },
    },
    include: { match: true },
  });

  // Group CLV samples by (market, leagueId)
  const byKey = new Map<string, { market: string; leagueId: string; samples: number[] }>();
  for (const p of preds) {
    if (p.clv === null) continue;
    // Use "none" sentinel when leagueId is null (Prisma compound key requires non-null)
    const lid = p.match.leagueId ?? "none";
    const key = `${p.market}|${lid}`;
    const entry = byKey.get(key) ?? {
      market: p.market,
      leagueId: lid,
      samples: [],
    };
    entry.samples.push(p.clv);
    byKey.set(key, entry);
  }

  for (const { market, leagueId, samples } of byKey.values()) {
    // Load existing row to combine samples (rolling window of 30)
    const existing = await db.marketLeagueClv.findUnique({
      where: { market_leagueId: { market, leagueId } },
    });
    const existingSamples: number[] = existing
      ? (() => { try { return JSON.parse(existing.samplesJson ?? "[]") as number[]; } catch { return []; } })()
      : [];
    const combined = [...existingSamples, ...samples].slice(-30);
    const avgClv = combined.reduce((s, x) => s + x, 0) / Math.max(1, combined.length);

    await db.marketLeagueClv.upsert({
      where: { market_leagueId: { market, leagueId } },
      create: {
        market,
        leagueId,
        avgClv,
        sampleCount: combined.length,
        samplesJson: JSON.stringify(combined),
      },
      update: {
        avgClv,
        sampleCount: combined.length,
        samplesJson: JSON.stringify(combined),
      },
    });
  }
}

/**
 * Load the per-(market, league) rolling CLV into a Map for fast lookup.
 * Key: `${market}|${leagueId ?? "none"}`. Value: avgClv.
 *
 * Used by the engine at prediction time to gate investment-grade picks.
 */
export async function loadMarketLeagueClvMap(): Promise<Map<string, number>> {
  const rows = await db.marketLeagueClv.findMany();
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.market}|${r.leagueId ?? "none"}`, r.avgClv);
  }
  return map;
}
