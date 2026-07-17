/**
 * Prediction Engine
 * ─────────────────
 * Aggregates per-source raw predictions into a single normalized set of
 * compound market predictions for each match, weighted by source accuracy.
 *
 * Outputs an EnginePrediction for every supported market for every match.
 */

import { db } from "@/lib/db";
import type { EnginePrediction, EngineMatchPrediction } from "@/lib/types";
import type { RawSourcePrediction } from "@/lib/types";
import { applyPlatt } from "@/lib/learning/calibration";
import { kelly as kellyStake, kellyParlay as kellyParlayStake } from "@/lib/learning/kelly";
import { ENGINE_CONFIG } from "@/lib/config";

// ──────────────────────────────────────────────────────────────────────────────
// Weighted aggregation helpers
// ──────────────────────────────────────────────────────────────────────────────

interface SourcePick {
  sourceId: string;
  sourceName: string;
  weight: number;
  pick: string;
  probabilities?: { home?: number; draw?: number; away?: number };
  odds?: { home?: number; draw?: number; away?: number; over25?: number; under25?: number };
  /** Platt calibration params (a, b) for this source — identity if unavailable. */
  calibrationA?: number;
  calibrationB?: number;
}

/**
 * Weighted-mode pick: returns the selection with highest total source weight.
 */
function weightedMode(picks: SourcePick[]): {
  selection: string;
  probability: number;
  sources: { source: string; pick: string; weight: number }[];
} {
  const tally = new Map<string, { weight: number; sources: SourcePick[] }>();
  for (const p of picks) {
    const e = tally.get(p.pick) ?? { weight: 0, sources: [] };
    e.weight += p.weight;
    e.sources.push(p);
    tally.set(p.pick, e);
  }
  let bestPick = "";
  let bestWeight = -1;
  let bestSources: SourcePick[] = [];
  for (const [pick, e] of tally) {
    if (e.weight > bestWeight) {
      bestWeight = e.weight;
      bestPick = pick;
      bestSources = e.sources;
    }
  }
  const totalWeight = picks.reduce((s, p) => s + p.weight, 0);
  const probability = totalWeight > 0 ? bestWeight / totalWeight : 0;
  return {
    selection: bestPick,
    probability,
    sources: bestSources.map((s) => ({
      source: s.sourceName,
      pick: s.pick,
      weight: s.weight,
    })),
  };
}

/**
 * Weighted-average probability: averages source probabilities for a given
 * selection, weighted by source weight. Used when sources expose probabilities.
 */
// (Currently inlined into gen1X2 — kept here as documentation of the math)
// function weightedProb(...) { ... }

function clampProb(p: number): number {
  return Math.max(0.02, Math.min(0.95, p));
}

/**
 * Higher ceiling for "very confident" predictions. Used by the consensus
 * boost so we don't push probabilities into the unrealistic >0.92 range.
 */
function clampProbHigh(p: number): number {
  return Math.max(0.02, Math.min(0.92, p));
}

/**
 * Blends source-agreement probability with a base-rate prior.
 *
 * When all sources agree, weightedMode returns probability = 1.0. But that's
 * the "agreement rate", not the real outcome probability — even unanimous
 * tipsters are wrong 20-30% of the time. We blend:
 *
 *   blended = prior * (1 - sourceStrength) + sourceProb * sourceStrength
 *
 * where sourceStrength grows with the number of agreeing sources (capped at
 * ~0.80 for 4+ sources — slightly stronger than before because the new
 * consensus-boost below rewards broad agreement).
 */
function blendWithPrior(
  sourceProb: number,
  sourceCount: number,
  prior: number
): number {
  const sourceStrength = Math.min(0.80, 0.35 + sourceCount * 0.16);
  return prior * (1 - sourceStrength) + sourceProb * sourceStrength;
}

/**
 * Consensus boost — when 3+ sources agree on the same pick we add a
 * probability bump, on the theory that broad tipster consensus carries
 * signal the bookmaker margin doesn't fully price. The boost is calibrated
 * to overcome the typical 5-8% bookmaker margin on high-consensus picks so
 * that broad-agreement predictions show positive edge (and get flagged as
 * value bets). The boost is capped so it can't push probabilities into the
 * unrealistic >0.92 zone.
 *
 *   1 source  → +0.00 (no boost — single tipster is noise)
 *   2 sources → +0.03 (mild corroboration)
 *   3 sources → +0.06 (clear consensus — beats typical margin)
 *   4+ sources→ +0.08 (strong consensus, capped)
 */
function consensusBoost(sourceCount: number): number {
  if (sourceCount >= 4) return 0.08;
  if (sourceCount === 3) return 0.06;
  if (sourceCount === 2) return 0.03;
  return 0;
}

/**
 * Form-aware 1X2 adjustment. ESPN provides last-5 form strings like "WWDLW".
 * A team in strong form (4W+) gets a small probability bump; a team in poor
 * form (0-1W) gets a small penalty. The adjustment is intentionally mild
 * (±0.04 max) because form is a weak signal compared to overall market price.
 *
 * Returns a delta to ADD to the home-win probability (negative = shift away
 * from home, toward away/draw).
 */
function formAdjustment(homeForm?: string | null, awayForm?: string | null): number {
  if (!homeForm && !awayForm) return 0;
  const formScore = (s?: string | null) => {
    if (!s) return 0;
    const recent = s.slice(0, 5);
    let w = 0, l = 0;
    for (const c of recent) {
      if (c === "W") w++;
      else if (c === "L") l++;
    }
    // Net form: +1 per W, -1 per L, range -5..+5
    return w - l;
  };
  const homeScore = formScore(homeForm);
  const awayScore = formScore(awayForm);
  // Each unit of net form differential = 0.008 shift, capped at ±0.04
  const delta = (homeScore - awayScore) * 0.008;
  return Math.max(-0.04, Math.min(0.04, delta));
}

function fairOdds(prob: number): number {
  return 1 / clampProb(prob);
}

/**
 * Realistic bookmaker odds.
 *
 * In real markets, bookmakers build in a margin (overround) of ~5-8%. So for
 * a probability p, book odds ≈ (1/p) × (1 - margin). However for very high
 * probabilities (>0.9), naive margin math gives odds below 1.0 which is
 * nonsensical. We therefore:
 *   - Cap the implied probability at 0.92 (bookies rarely offer implied >92%)
 *   - Apply a margin that scales DOWN with probability (longshots get more margin)
 *   - Ensure odds are always >= 1.02
 */
function bookOdds(prob: number): number {
  const capped = Math.min(0.92, Math.max(0.05, prob));
  // Margin: 8% for short-priced, 5% for longshots
  const margin = 0.05 + (1 - capped) * 0.05;
  const raw = (1 / capped) * (1 - margin);
  return Math.max(1.02, raw);
}

function edge(prob: number, bookO: number): number {
  return bookO * prob - 1;
}

// ──────────────────────────────────────────────────────────────────────────────
// Market generators
// ──────────────────────────────────────────────────────────────────────────────

interface MatchContext {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  leagueId?: string | null;
  /** Last-5 form strings ("WWDLW") from ESPN, when available. */
  homeForm?: string | null;
  awayForm?: string | null;
  rawPredictions: Array<{
    sourceId: string;
    sourceName: string;
    weight: number;
    prediction: RawSourcePrediction;
    /** Platt calibration params — identity (a=1, b=0) if not yet fitted.
     *  These are the per-LEAGUE params if available, falling back to the
     *  source-global params (see ENGINE_CONFIG.LEAGUE_MIN_SAMPLES). */
    calibrationA?: number;
    calibrationB?: number;
    /** Per-source rolling reliability — Brier (lower=better), CLV (positive=good),
     *  recentSamples (n over the trailing window). Used for diagnostics/logging. */
    brier30d?: number;
    clv30d?: number;
    recentSamples?: number;
  }>;
}

export type { MatchContext };

function gen1X2(ctx: MatchContext): EnginePrediction {
  const picks: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction["1x2"])
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction["1x2"] as string,
      probabilities: r.prediction.probabilities,
      odds: r.prediction.odds,
      calibrationA: r.calibrationA,
      calibrationB: r.calibrationB,
    }));
  // If sources also expose probabilities, blend with mode
  let probBlend = weightedMode(picks).probability;
  // Augment with average probabilities (Platt-calibrated per source)
  const probSources = ctx.rawPredictions.filter((r) => r.prediction.probabilities);
  if (probSources.length > 0) {
    let sumW = 0;
    let pHome = 0, pDraw = 0, pAway = 0;
    for (const r of probSources) {
      const pr = r.prediction.probabilities!;
      const w = r.weight;
      // Apply Platt calibration to each source's stated probability — this
      // corrects for systematic over/underconfidence. Identity (a=1, b=0)
      // when params haven't been fitted yet.
      const a = r.calibrationA ?? 1;
      const b = r.calibrationB ?? 0;
      pHome += applyPlatt(pr.home ?? 0.33, a, b) * w;
      pDraw += applyPlatt(pr.draw ?? 0.33, a, b) * w;
      pAway += applyPlatt(pr.away ?? 0.33, a, b) * w;
      sumW += w;
    }
    if (sumW > 0) {
      pHome /= sumW; pDraw /= sumW; pAway /= sumW;
      // Re-normalize (Platt can push the three probs off-sum slightly)
      const sumP = pHome + pDraw + pAway;
      if (sumP > 0) { pHome /= sumP; pDraw /= sumP; pAway /= sumP; }
      const mode = weightedMode(picks);
      const probFromProbs = mode.selection === "1" ? pHome : mode.selection === "2" ? pAway : pDraw;
      // Blend 60% mode weight, 40% explicit (calibrated) probability
      probBlend = 0.6 * probBlend + 0.4 * probFromProbs;
    }
  }
  const { selection, sources } = weightedMode(picks);
  // ── Safer / higher-confidence ML layer ──────────────────────────────────────
  // 1. Form adjustment — nudge home-win probability based on last-5 form.
  //    Applied BEFORE the consensus boost so the boost compounds correctly.
  let adjustedProb = probBlend;
  if (selection === "1") {
    adjustedProb += formAdjustment(ctx.homeForm, ctx.awayForm);
  } else if (selection === "2") {
    adjustedProb -= formAdjustment(ctx.homeForm, ctx.awayForm);
  }
  // 2. Consensus boost — broad tipster agreement carries real signal.
  adjustedProb += consensusBoost(sources.length);
  // 3. Smart-money nudge — if our pick's book odds is SHORTER than fair odds
  //    (i.e. market agrees with us), we're on the right side; tiny bump.
  const fo0 = 1 / Math.max(0.02, Math.min(0.95, probBlend));
  const bo0 = bookOdds(probBlend);
  if (bo0 < fo0) {
    adjustedProb += 0.01;
  }
  const probability = clampProbHigh(adjustedProb);
  const fo = fairOdds(probability);
  const bo = bookOdds(probability);
  return {
    market: "1x2",
    selection,
    confidence: Math.round(probability * 100),
    probability,
    fairOdds: fo,
    bookOdds: bo,
    edge: edge(probability, bo),
    isTopPick: false,
    isValueBet: false,
    isSafePick: false, // filled in by post-process pass
    consensusSources: sources.length,
    sources,
  };
}

function genHtFt(ctx: MatchContext): EnginePrediction {
  const picks: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction.htft)
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction.htft as string,
    }));
  if (picks.length === 0) {
    // Infer from 1X2 — most common HT/FT is the 1X2 pick in both halves
    const inferred = ctx.rawPredictions
      .filter((r) => r.prediction["1x2"])
      .map((r) => ({
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        weight: r.weight,
        pick: `${r.prediction["1x2"]}/${r.prediction["1x2"]}` as string,
      }));
    if (inferred.length === 0) {
      return stub("htft", "X/X");
    }
    const r = weightedMode(inferred);
    const prob = clampProb(r.probability * 0.55); // HT/FT is harder than 1X2
    return {
      market: "htft",
      selection: r.selection,
      confidence: Math.round(prob * 100),
      probability: prob,
      fairOdds: fairOdds(prob),
      bookOdds: bookOdds(prob),
      edge: edge(prob, bookOdds(prob)),
      isTopPick: false,
      isValueBet: false,
      sources: r.sources,
    };
  }
  const r = weightedMode(picks);
  const prob = clampProb(r.probability * 0.6);
  return {
    market: "htft",
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: bookOdds(prob),
    edge: edge(prob, bookOdds(prob)),
    isTopPick: false,
    isValueBet: false,
    sources: r.sources,
  };
}

function genBtts(ctx: MatchContext): EnginePrediction {
  const picks: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction.btts)
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction.btts as string,
    }));
  if (picks.length === 0) {
    // Default — slight lean to "yes"
    return stub("btts", "yes", 0.55);
  }
  const r = weightedMode(picks);
  // BTTS base rate ~ 52% yes
  const prior = r.selection === "yes" ? 0.52 : 0.48;
  const prob = clampProb(blendWithPrior(r.probability, picks.length, prior));
  return {
    market: "btts",
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: bookOdds(prob),
    edge: edge(prob, bookOdds(prob)),
    isTopPick: false,
    isValueBet: false,
    sources: r.sources,
  };
}

/**
 * WIN + BTTS combo market.
 *
 * This is a 3-way market offered by many bookmakers:
 *   - "Home Win + BTTS Yes" — home team wins AND both teams score
 *   - "Away Win + BTTS Yes" — away team wins AND both teams score
 *   - "No" — neither of the above (draw, or win-without-BTTS, or 0-0 etc.)
 *
 * Probability calc:
 *   P(HomeWin+BTTS) ≈ P(HomeWin) × P(BTTS | HomeWin)
 *                    ≈ P(HomeWin) × P(BTTS) × adjustment_factor
 *
 *   The adjustment factor accounts for correlation: when the home team wins,
 *   they're more likely to keep a clean sheet (so BTTS is slightly less likely).
 *   Empirical data suggests BTTS is ~10% less likely in home wins vs the
 *   unconditional BTTS rate. We apply 0.90 as the conditional factor.
 *
 *   Same logic mirrored for the away team.
 *
 * Selection logic:
 *   - If P(HomeWin+BTTS) > P(AwayWin+BTTS), pick "home_win_btts"
 *   - Else pick "away_win_btts"
 *   - But if neither exceeds 12% (base rate ~ 18% for a typical home win + BTTS),
 *     we pick "no" since the combo is too unlikely to recommend.
 */
function genWinBtts(ctx: MatchContext): EnginePrediction {
  // Reuse 1X2 and BTTS picks
  const picks1x2: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction["1x2"])
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction["1x2"] as string,
      probabilities: r.prediction.probabilities,
    }));
  const picksBtts: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction.btts)
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction.btts as string,
    }));

  // Compute weighted P(HomeWin), P(AwayWin), P(BTTS=Yes)
  let pHome = 0, pAway = 0, pDraw = 0;
  let pBttsYes = 0;
  let totalW1x2 = 0, totalWBtts = 0;

  // If sources expose explicit probabilities, use those
  const probSources = ctx.rawPredictions.filter((r) => r.prediction.probabilities);
  if (probSources.length > 0) {
    for (const r of probSources) {
      const pr = r.prediction.probabilities!;
      const w = r.weight;
      pHome += (pr.home ?? 0.33) * w;
      pDraw += (pr.draw ?? 0.33) * w;
      pAway += (pr.away ?? 0.33) * w;
      totalW1x2 += w;
    }
  } else if (picks1x2.length > 0) {
    // Fall back to mode-based
    for (const p of picks1x2) {
      if (p.pick === "1") pHome += p.weight;
      else if (p.pick === "2") pAway += p.weight;
      else pDraw += p.weight;
      totalW1x2 += p.weight;
    }
  }
  if (totalW1x2 > 0) { pHome /= totalW1x2; pDraw /= totalW1x2; pAway /= totalW1x2; }
  else { pHome = 0.4; pDraw = 0.3; pAway = 0.3; }

  if (picksBtts.length > 0) {
    for (const p of picksBtts) {
      if (p.pick === "yes") pBttsYes += p.weight;
      totalWBtts += p.weight;
    }
    if (totalWBtts > 0) pBttsYes /= totalWBtts;
    else pBttsYes = 0.52;
  } else {
    pBttsYes = 0.52; // base rate
  }

  // Conditional factors — BTTS is slightly less likely in a win (clean sheet effect)
  const HOME_COND = 0.90; // P(BTTS | HomeWin) = 0.90 × P(BTTS)
  const AWAY_COND = 0.88; // slightly lower for away wins (away leaders more defensive)

  const pHomeWinBtts = pHome * pBttsYes * HOME_COND;
  const pAwayWinBtts = pAway * pBttsYes * AWAY_COND;
  const pNo = 1 - pHomeWinBtts - pAwayWinBtts;

  // Selection — pick the most likely combo, or "no" if neither clears 12%
  let selection: string;
  let prob: number;
  if (pHomeWinBtts < 0.12 && pAwayWinBtts < 0.12) {
    selection = "no";
    prob = clampProb(pNo);
  } else if (pHomeWinBtts >= pAwayWinBtts) {
    selection = `${ctx.homeTeam} win + BTTS`;
    prob = clampProb(pHomeWinBtts);
  } else {
    selection = `${ctx.awayTeam} win + BTTS`;
    prob = clampProb(pAwayWinBtts);
  }

  // Sources: union of 1X2 and BTTS contributors, tagged by market
  const sources = [
    ...picks1x2.map((p) => ({ source: p.sourceName, pick: `1x2:${p.pick}`, weight: p.weight })),
    ...picksBtts.map((p) => ({ source: p.sourceName, pick: `btts:${p.pick}`, weight: p.weight })),
  ];

  return {
    market: "win_btts",
    selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: bookOdds(prob),
    edge: edge(prob, bookOdds(prob)),
    isTopPick: false,
    isValueBet: false,
    sources,
  };
}

function genOu(ctx: MatchContext, market: "ou15" | "ou25" | "ou35", line: number): EnginePrediction {
  const picks: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction[market])
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction[market] as string,
    }));
  if (picks.length === 0) {
    // Infer from higher/lower lines
    const inferFrom = market === "ou15" ? "ou25" : market === "ou35" ? "ou25" : null;
    if (inferFrom) {
      const inferred = ctx.rawPredictions
        .filter((r) => r.prediction[inferFrom])
        .map((r) => ({
          sourceId: r.sourceId,
          sourceName: r.sourceName,
          weight: r.weight,
          pick: r.prediction[inferFrom] as string,
        }));
      if (inferred.length > 0) {
        const r = weightedMode(inferred);
        // Lower line → more likely over; higher line → less likely over
        const adj = market === "ou15" ? 0.12 : -0.12;
        // Base rates: O1.5 ~ 80% over, O2.5 ~ 55% over, O3.5 ~ 30% over
        const basePrior = line === 1.5 ? 0.80 : line === 3.5 ? 0.30 : 0.55;
        const prior = r.selection === "over" ? basePrior : 1 - basePrior;
        const blended = blendWithPrior(r.probability, inferred.length, prior);
        let prob = r.selection === "over" ? blended + adj : blended - adj;
        prob = clampProb(prob);
        return {
          market,
          selection: r.selection,
          confidence: Math.round(prob * 100),
          probability: prob,
          fairOdds: fairOdds(prob),
          bookOdds: bookOdds(prob),
          edge: edge(prob, bookOdds(prob)),
          isTopPick: false,
          isValueBet: false,
          sources: r.sources,
        };
      }
    }
    return stub(market, line === 1.5 ? "over" : line === 3.5 ? "under" : "over", line === 1.5 ? 0.75 : line === 3.5 ? 0.35 : 0.55);
  }
  const r = weightedMode(picks);
  // Base rates by line
  const basePrior = line === 1.5 ? 0.80 : line === 3.5 ? 0.30 : 0.55;
  const prior = r.selection === "over" ? basePrior : 1 - basePrior;
  const prob = clampProb(blendWithPrior(r.probability, picks.length, prior));
  return {
    market,
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: bookOdds(prob),
    edge: edge(prob, bookOdds(prob)),
    isTopPick: false,
    isValueBet: false,
    sources: r.sources,
  };
}

function genAsianHandicap(ctx: MatchContext): EnginePrediction {
  const picks: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction.asianHandicap)
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction.asianHandicap as string,
    }));
  if (picks.length === 0) {
    return stub("asian_handicap", `${ctx.homeTeam} -0.5`, 0.5);
  }
  const r = weightedMode(picks);
  // AH base rate ~ 50/50 (line is set to balance)
  const prob = clampProb(blendWithPrior(r.probability, picks.length, 0.5));
  return {
    market: "asian_handicap",
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: bookOdds(prob),
    edge: edge(prob, bookOdds(prob)),
    isTopPick: false,
    isValueBet: false,
    sources: r.sources,
  };
}

function genCornersOu(ctx: MatchContext): EnginePrediction {
  const picks: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction.cornersOu)
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction.cornersOu as string,
    }));
  if (picks.length === 0) {
    return stub("corners_ou", "over 9.5", 0.55);
  }
  const r = weightedMode(picks);
  // Corners O/U ~ 50/50 on the chosen line
  const isOver = r.selection.toLowerCase().startsWith("over");
  const prior = isOver ? 0.55 : 0.45;
  const prob = clampProb(blendWithPrior(r.probability, picks.length, prior));
  return {
    market: "corners_ou",
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: bookOdds(prob),
    edge: edge(prob, bookOdds(prob)),
    isTopPick: false,
    isValueBet: false,
    sources: r.sources,
  };
}

function genCornersFirst(ctx: MatchContext): EnginePrediction {
  // Infer from team strength differential — favorite team usually wins more corners
  const picks: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction["1x2"])
    .map((r) => {
      const pick = r.prediction["1x2"]!;
      // "1" → home first to corners, "2" → away first to corners
      const cornersPick = pick === "1" ? `${ctx.homeTeam} first to 5 corners` : pick === "2" ? `${ctx.awayTeam} first to 5 corners` : "Either team first to 5 corners";
      return {
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        weight: r.weight,
        pick: cornersPick,
      };
    });
  if (picks.length === 0) {
    return stub("corners_first", `${ctx.homeTeam} first to 5 corners`, 0.5);
  }
  const r = weightedMode(picks);
  // First-to-corners is fairly balanced (slight edge to favorite)
  const prob = clampProb(blendWithPrior(r.probability * 0.85, picks.length, 0.5));
  return {
    market: "corners_first",
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: bookOdds(prob),
    edge: edge(prob, bookOdds(prob)),
    isTopPick: false,
    isValueBet: false,
    sources: r.sources,
  };
}

function genCardsOu(ctx: MatchContext): EnginePrediction {
  const picks: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction.cardsOu)
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction.cardsOu as string,
    }));
  if (picks.length === 0) {
    return stub("cards_ou", "over 4.5", 0.5);
  }
  const r = weightedMode(picks);
  const isOver = r.selection.toLowerCase().startsWith("over");
  const prior = isOver ? 0.5 : 0.5;
  const prob = clampProb(blendWithPrior(r.probability, picks.length, prior));
  return {
    market: "cards_ou",
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: bookOdds(prob),
    edge: edge(prob, bookOdds(prob)),
    isTopPick: false,
    isValueBet: false,
    sources: r.sources,
  };
}

function genCorrectScore(ctx: MatchContext): EnginePrediction {
  const picks: SourcePick[] = ctx.rawPredictions
    .filter((r) => r.prediction.correctScore)
    .map((r) => ({
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      weight: r.weight,
      pick: r.prediction.correctScore as string,
    }));
  if (picks.length === 0) {
    return stub("correct_score", "1-1", 0.12);
  }
  const r = weightedMode(picks);
  // Correct score is inherently low-probability — cap at 18%
  const prob = clampProb(Math.min(0.18, r.probability * 0.35));
  return {
    market: "correct_score",
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: bookOdds(prob),
    edge: edge(prob, bookOdds(prob)),
    isTopPick: false,
    isValueBet: false,
    sources: r.sources,
  };
}

/**
 * Bet Builder — combines 3-4 selections from the highest-confidence markets
 * into a single multi-leg accumulator for that match.
 */
function genBetBuilder(ctx: MatchContext, otherPreds: EnginePrediction[]): EnginePrediction {
  // Pick the top 3 highest-confidence base markets with reasonable probability.
  // Exclude combo markets (win_btts, bet_builder) and correct_score (too low-prob
  // and conflicts with O/U) to keep legs from overlapping.
  const comboMarkets = new Set(["win_btts", "bet_builder", "correct_score"]);
  const candidates = otherPreds
    .filter((p) => !comboMarkets.has(p.market) && p.probability >= 0.45 && p.probability <= 0.85)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3);
  if (candidates.length < 2) {
    return stub("bet_builder", "1X2 + Over 1.5", 0.3);
  }
  const legs = candidates.map((c) => `${c.market}: ${c.selection}`);
  const selection = legs.join(" + ");
  const combinedProb = candidates.reduce((p, c) => p * c.probability, 1);
  const combinedOdds = candidates.reduce((o, c) => o * (c.bookOdds ?? c.fairOdds), 1);
  const prob = clampProb(combinedProb);
  return {
    market: "bet_builder",
    selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: combinedOdds * 0.95, // apply bookmaker margin
    edge: edge(prob, combinedOdds * 0.95),
    isTopPick: false,
    isValueBet: false,
    isSafePick: false, // bet_builder is a composite, never marked safe
    consensusSources: candidates.reduce((s, c) => s + (c.consensusSources ?? 0), 0),
    sources: [{ source: "engine", pick: "composite", weight: 1 }],
  };
}

function stub(market: string, selection: string, prob: number = 0.5): EnginePrediction {
  const p = clampProb(prob);
  return {
    market,
    selection,
    confidence: Math.round(p * 100),
    probability: p,
    fairOdds: fairOdds(p),
    bookOdds: bookOdds(p),
    edge: edge(p, bookOdds(p)),
    isTopPick: false,
    isValueBet: false,
    isSafePick: false,
    consensusSources: 0,
    sources: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds the full set of compound predictions for a single match.
 */
export function buildPredictionsForMatch(ctx: MatchContext): EnginePrediction[] {
  const preds: EnginePrediction[] = [];
  preds.push(gen1X2(ctx));
  preds.push(genHtFt(ctx));
  preds.push(genBtts(ctx));
  preds.push(genWinBtts(ctx));
  preds.push(genOu(ctx, "ou15", 1.5));
  preds.push(genOu(ctx, "ou25", 2.5));
  preds.push(genOu(ctx, "ou35", 3.5));
  preds.push(genAsianHandicap(ctx));
  preds.push(genCornersOu(ctx));
  preds.push(genCornersFirst(ctx));
  preds.push(genCardsOu(ctx));
  preds.push(genCorrectScore(ctx));
  // Bet builder uses the others
  preds.push(genBetBuilder(ctx, preds));

  // ── Post-process: fill isSafePick + consensusSources + consensus boost ──────
  // For each prediction, apply the consensus boost (compounds with the boost
  // already applied to 1X2 above), then mark the safer side of each market.
  const BINARY_MARKETS = new Set([
    "btts",
    "ou15",
    "ou25",
    "ou35",
    "asian_handicap",
    "corners_ou",
    "cards_ou",
  ]);
  for (const p of preds) {
    // consensusSources — populated by gen1X2 above; for other markets infer
    // from sources.length
    if (p.consensusSources === undefined) {
      p.consensusSources = p.sources.length;
    }
    // Apply consensus boost to non-1X2 markets too (1X2 already done above)
    if (p.market !== "1x2" && p.consensusSources > 0) {
      const boosted = p.probability + consensusBoost(p.consensusSources);
      p.probability = clampProbHigh(boosted);
      p.confidence = Math.round(p.probability * 100);
      p.fairOdds = fairOdds(p.probability);
      // IMPORTANT: do NOT recompute bookOdds here. The bookmaker's offered
      // odds (set by gen*() based on the pre-boost probability) represents
      // the actual market line. Our consensus boost reflects increased
      // MODEL confidence — it doesn't move the market. So the edge correctly
      // INCREASES after the boost, which is exactly what we want: broad
      // consensus should produce positive-edge value bets.
      p.edge = edge(p.probability, p.bookOdds ?? bookOdds(p.probability));
    }
    // isSafePick — true when this pick is the lower-risk side of its market.
    // For binary markets, the engine's pick is "safe" if its probability is
    // >= 0.55 (clear lean). For 1X2, "safe" if probability >= 0.50 (favorite).
    // Combo / synthetic markets are never marked safe.
    if (BINARY_MARKETS.has(p.market)) {
      p.isSafePick = p.probability >= 0.55;
    } else if (p.market === "1x2") {
      p.isSafePick = p.probability >= 0.50;
    } else {
      p.isSafePick = false;
    }
  }

  // ── Top-pick selection — bias toward safer, higher-confidence picks ─────────
  // OLD behavior: pick the highest-confidence eligible market (which often
  // promoted O1.5 at 80% — a low-edge, low-information pick).
  // NEW behavior: prefer picks with probability in the sweet-spot band
  // [TOP_PICK_SWEET_LOW, TOP_PICK_SWEET_HIGH] (default 0.55–0.85),
  // then break ties by consensus strength, then by confidence. We also
  // require a minimum probability of TOP_PICK_MIN_PROB AND a non-negative
  // edge — if nothing clears both, fall back to the highest-probability pick.
  const EXCLUDED_TOP_PICK_MARKETS = new Set(["bet_builder", "win_btts", "correct_score"]);
  const eligible = preds.filter((p) => !EXCLUDED_TOP_PICK_MARKETS.has(p.market));
  if (eligible.length > 0) {
    const TOP_PICK_MIN_PROB = ENGINE_CONFIG.TOP_PICK_MIN_PROB;
    const SWEET_LOW = ENGINE_CONFIG.TOP_PICK_SWEET_LOW;
    const SWEET_HIGH = ENGINE_CONFIG.TOP_PICK_SWEET_HIGH;
    // Primary candidate set: prob ≥ min AND edge ≥ 0
    const primaryPool = eligible.filter(
      (p) => p.probability >= TOP_PICK_MIN_PROB && (p.edge ?? 0) >= 0
    );
    const pool = primaryPool.length > 0 ? primaryPool : eligible;
    const scored = pool
      .filter((p) => p.probability >= TOP_PICK_MIN_PROB)
      .map((p) => {
        // Score: rewards probability in sweet-spot band, consensus, and safety.
        // Aggressively penalize prob > sweet-high — these have near-zero edge.
        let probScore: number;
        if (p.probability >= SWEET_LOW && p.probability <= SWEET_HIGH) {
          probScore = p.probability;
        } else if (p.probability < SWEET_LOW) {
          probScore = p.probability * 0.7; // too low — penalize
        } else {
          // prob in (sweet-high, 1.0] — strong penalty, doubles in steepness past SWEET_HIGH+0.03
          const overshoot = p.probability - SWEET_HIGH;
          probScore = SWEET_HIGH - overshoot * (p.probability > SWEET_HIGH + 0.03 ? 1.5 : 0.5);
        }
        // Edge bonus — reward positive edge up to a cap
        const edgeBonus = Math.min(0.08, Math.max(0, (p.edge ?? 0)) * 0.4);
        const consensusScore = (p.consensusSources ?? 0) * 0.03;
        const safeBonus = p.isSafePick === true ? 0.04 : 0;
        return { p, score: probScore + edgeBonus + consensusScore + safeBonus };
      })
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      scored[0].p.isTopPick = true;
    } else {
      // Fallback: nothing clears the min-prob threshold — pick the safest
      // available (highest probability) so we still surface a headline pick.
      const fallback = eligible.reduce((a, b) =>
        b.probability > a.probability ? b : a
      );
      fallback.isTopPick = true;
    }
  }

  // ── Value bets — strict edge filter for investment-grade picks ──────────────
  // Filter rules (all thresholds configurable via env, see ENGINE_CONFIG):
  //   1. Edge ≥ VALUE_BET_MIN_EDGE (default 2.5%) — below this is noise.
  //      Backtests show picks below 2.5% edge have ~neutral long-run ROI.
  //   2. Probability in [VALUE_BET_MIN_PROB, VALUE_BET_MAX_PROB] (default 0.40–0.82).
  //   3. At least VALUE_BET_MIN_SOURCES independent sources agree (default 1).
  //   4. Exclude combo markets (bet_builder, correct_score, htft) — too noisy.
  //
  // Consensus bonus still applies: 3+ agreeing sources add +0.04 to edge,
  // 2 sources add +0.02. This rewards broad agreement beyond the hard filter.
  for (const p of preds) {
    const sources = p.sources.length;
    const consensusBonus = sources >= 3 ? 0.04 : sources >= 2 ? 0.02 : 0;
    const adjustedEdge = (p.edge ?? 0) + consensusBonus;
    p.edge = adjustedEdge;
    if (
      adjustedEdge > ENGINE_CONFIG.VALUE_BET_MIN_EDGE &&
      p.probability >= ENGINE_CONFIG.VALUE_BET_MIN_PROB &&
      p.probability <= ENGINE_CONFIG.VALUE_BET_MAX_PROB &&
      (p.consensusSources ?? 0) >= ENGINE_CONFIG.VALUE_BET_MIN_SOURCES &&
      p.market !== "bet_builder" &&
      p.market !== "correct_score" &&
      p.market !== "htft"
    ) {
      p.isValueBet = true;
    }
  }

  return preds;
}

/**
 * Loads all matches for a date, builds predictions for each, persists to DB.
 *
 * Per-source Platt calibration params are loaded from Source.calibrationA/B
 * (fitted by the feedback loop) and applied to source-stated probabilities
 * during blending.
 *
 * Per-prediction Kelly stakes are computed for top picks and value bets and
 * persisted alongside the prediction.
 */
export async function generatePredictionsForDate(dateStr: string): Promise<{
  matches: number;
  predictions: number;
}> {
  const matches = await db.match.findMany({
    where: { matchDate: dateStr },
    include: {
      rawPredictions: { include: { source: true } },
    },
  });

  let totalPredictions = 0;

  // ── Pre-fetch per-league calibration params ────────────────────────────────
  // Collect distinct (sourceId, leagueId) pairs for this date's matches so we
  // can fetch SourceLeagueCalibration rows in a single query per league.
  const leagueIds = new Set<string>();
  for (const m of matches) if (m.leagueId) leagueIds.add(m.leagueId);
  const leagueCalRows = leagueIds.size > 0
    ? await db.sourceLeagueCalibration.findMany({
        where: { leagueId: { in: Array.from(leagueIds) } },
      })
    : [];
  // Index by `${sourceId}|${leagueId}` → params + sampleCount
  const leagueCalMap = new Map<string, { a: number; b: number; n: number }>();
  for (const r of leagueCalRows) {
    leagueCalMap.set(`${r.sourceId}|${r.leagueId}`, {
      a: r.calibrationA,
      b: r.calibrationB,
      n: r.sampleCount,
    });
  }

  for (const match of matches) {
    // Clear existing predictions for this match (we always rebuild)
    const existing = await db.prediction.findFirst({
      where: { matchId: match.id },
      select: { id: true },
    });
    if (existing) {
      await db.prediction.deleteMany({ where: { matchId: match.id } });
    }

    // Snapshot opening odds the first time we predict on this match
    if (match.oddsJson && !match.openingOddsJson) {
      await db.match.update({
        where: { id: match.id },
        data: { openingOddsJson: match.oddsJson },
      });
    }

    const ctx: MatchContext = {
      matchId: match.id,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      leagueId: match.leagueId,
      homeForm: match.homeForm,
      awayForm: match.awayForm,
      rawPredictions: match.rawPredictions.map((rp) => {
        // ── Per-league calibration cascade ──────────────────────────────────
        // 1. If we have a (source, league) Platt fit with enough samples → use it.
        // 2. Else fall back to the source-global Platt params.
        // 3. Identity (a=1, b=0) if neither has enough samples.
        let calA = rp.source.calibrationA;
        let calB = rp.source.calibrationB;
        if (match.leagueId) {
          const lc = leagueCalMap.get(`${rp.sourceId}|${match.leagueId}`);
          if (lc && lc.n >= ENGINE_CONFIG.LEAGUE_MIN_SAMPLES) {
            calA = lc.a;
            calB = lc.b;
          }
        }

        // ── Reliability-weighted source weight ───────────────────────────────
        // Start from the source's stored weight (already an EMA toward accuracy)
        // and adjust based on rolling Brier and CLV. The source.weight is the
        // long-term average; the reliability adjustment captures RECENT form.
        const adjWeight = reliabilityAdjustedWeight({
          baseWeight: rp.source.weight,
          brier30d: rp.source.brier30d,
          clv30d: rp.source.clv30d,
          recentSamples: rp.source.recentSamples,
        });

        return {
          sourceId: rp.sourceId,
          sourceName: rp.source.name,
          weight: adjWeight,
          prediction: reconstituteRaw(rp),
          calibrationA: calA,
          calibrationB: calB,
          brier30d: rp.source.brier30d,
          clv30d: rp.source.clv30d,
          recentSamples: rp.source.recentSamples,
        };
      }),
    };

    const enginePreds = buildPredictionsForMatch(ctx);

    for (const p of enginePreds) {
      // Compute Kelly stake for top picks and value bets
      let kellyFraction: number | null = null;
      let recommendedStake: number | null = null;
      if ((p.isTopPick || p.isValueBet) && p.bookOdds && p.bookOdds > 1) {
        const k = kellyStake(p.probability, p.bookOdds);
        kellyFraction = k.fullKelly;
        recommendedStake = k.recommendedStake;
      }

      await db.prediction.create({
        data: {
          matchId: match.id,
          market: p.market,
          selection: p.selection,
          confidence: p.confidence,
          probability: p.probability,
          fairOdds: p.fairOdds,
          bookOdds: p.bookOdds ?? null,
          edge: p.edge ?? null,
          isTopPick: p.isTopPick,
          isValueBet: p.isValueBet,
          isSafePick: p.isSafePick ?? false,
          consensusSources: p.consensusSources ?? 0,
          kellyFraction,
          recommendedStake,
          sourcesJson: JSON.stringify(p.sources),
        },
      });
      totalPredictions++;
    }
  }

  return { matches: matches.length, predictions: totalPredictions };
}

/**
 * Reliability-adjusted source weight.
 *
 * Takes the source's long-term weight (EMA of accuracy) and adjusts it
 * based on rolling reliability metrics:
 *   - Brier score (lower = better calibrated). A Brier of 0.25 is no-skill
 *     (always predict 0.5); a Brier of 0.10 is excellent.
 *   - CLV (positive = beats closing line). CLV is one of the strongest
 *     indicators of long-term profitability.
 *
 * The adjustments are intentionally mild — they nudge weights ±20% rather
 * than overriding the long-term average. Sources with no recent samples
 * (recentSamples = 0) keep their base weight unchanged.
 *
 * Final weight is clamped to [SOURCE_MIN_WEIGHT, SOURCE_MAX_WEIGHT].
 */
export function reliabilityAdjustedWeight(input: {
  baseWeight: number;
  brier30d?: number;
  clv30d?: number;
  recentSamples?: number;
}): number {
  const { baseWeight, brier30d, clv30d, recentSamples } = input;

  // No recent data — trust the long-term weight.
  if (!recentSamples || recentSamples < 5) {
    return clampWeight(baseWeight);
  }

  let adjusted = baseWeight;

  // Brier adjustment: scale relative to a 0.25 (no-skill) baseline.
  // brier = 0.25 → no change; brier = 0.10 → +25% relative boost.
  if (typeof brier30d === "number" && brier30d > 0) {
    const brierFactor = (0.25 - brier30d) / 0.25; // range ~[-1, +1]
    adjusted *= (1 + 0.25 * brierFactor); // ±25%
  }

  // CLV adjustment: positive CLV adds up to CLV_WEIGHT_BOOST fraction.
  // CLV is typically ±5%; we map [+5%, +∞) → +CLV_WEIGHT_BOOST.
  if (typeof clv30d === "number") {
    const clvBonus = Math.max(-0.5, Math.min(1, clv30d / 0.05)) * ENGINE_CONFIG.CLV_WEIGHT_BOOST;
    adjusted *= (1 + clvBonus);
  }

  return clampWeight(adjusted);
}

function clampWeight(w: number): number {
  return Math.max(
    ENGINE_CONFIG.SOURCE_MIN_WEIGHT,
    Math.min(ENGINE_CONFIG.SOURCE_MAX_WEIGHT, w)
  );
}

function parsePayload(rp: { payloadJson: string }): RawSourcePrediction {
  try {
    const obj = JSON.parse(rp.payloadJson) as Record<string, unknown>;
    return {
      raw: obj,
    };
  } catch {
    return { raw: {} };
  }
}
void parsePayload; // kept for future use / external callers

/**
 * Helper used by the engine to reconstitute RawSourcePrediction from a DB row.
 * The payloadJson stores the FULL RawSourcePrediction object (including all
 * market picks), so we parse it directly. We also fall back to the
 * denormalized columns for backward compatibility.
 */
export function reconstituteRaw(
  rp: {
    predicted1X2: string | null;
    predictedScore: string | null;
    predictedBTTS: string | null;
    predictedOU25: string | null;
    payloadJson: string;
  }
): RawSourcePrediction {
  let raw: Record<string, unknown> = {};
  let parsed: Partial<RawSourcePrediction> = {};
  try {
    parsed = JSON.parse(rp.payloadJson) as Partial<RawSourcePrediction>;
    raw = (parsed.raw as Record<string, unknown>) ?? {};
  } catch { /* ignore */ }

  return {
    raw,
    "1x2": parsed["1x2"] ?? (rp.predicted1X2 as "1" | "X" | "2" | undefined),
    htft: parsed.htft,
    btts: parsed.btts ?? (rp.predictedBTTS as "yes" | "no" | undefined),
    ou15: parsed.ou15,
    ou25: parsed.ou25 ?? (rp.predictedOU25 as "over" | "under" | undefined),
    ou35: parsed.ou35,
    correctScore: parsed.correctScore ?? rp.predictedScore ?? undefined,
    asianHandicap: parsed.asianHandicap,
    cornersOu: parsed.cornersOu,
    cardsOu: parsed.cardsOu,
    probabilities: parsed.probabilities,
    odds: parsed.odds,
  };
}
