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
import { applyPortfolioCap, computeDrawdownState, type DrawdownState } from "@/lib/learning/risk";
import { loadMarketLeagueClvMap } from "@/lib/learning/feedback";
import { loadEloProbability, DEFAULT_ELO } from "@/lib/learning/elo";
import { fitGoalModel, goalModelOverUnder, goalModelBtts, goalModelCorrectScore, goalModelMostLikelyScore, goalModel1X2, type GoalModelFit } from "./poisson";
import { h2hProbability } from "./h2h";
import { formProbability } from "./form-model";
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
 * ── A3 upgrade: venue-split form + rest-day penalty ────────────────────────
 * When `homeVenueForm`/`awayVenueForm` are available, use them INSTEAD of
 * overall form — a team may be W5 at home but L5 away, and the venue-specific
 * string captures this. Falls back to overall form when venue form is missing.
 *
 * Rest-day penalty: when a team has < REST_PENALTY_THRESHOLD days of rest
 * (default 3), apply a small probability reduction. Each day below threshold
 * → REST_PENALTY_PER_DAY reduction (capped at REST_PENALTY_MAX). Midweek
 * Champions League / Europa teams playing Sat-Tue-Sat are well-documented
 * to score ~5-8% fewer goals.
 *
 * Returns a delta to ADD to the home-win probability (negative = shift away
 * from home, toward away/draw).
 */
function formAdjustment(
  homeForm?: string | null,
  awayForm?: string | null,
  homeVenueForm?: string | null,
  awayVenueForm?: string | null,
  restDaysHome?: number | null,
  restDaysAway?: number | null
): number {
  // ── Form component (uses venue-split when available) ──────────────────────
  const formScore = (overall?: string | null, venue?: string | null) => {
    const s = venue ?? overall;
    if (!s) return 0;
    const recent = s.slice(0, 5);
    let w = 0, l = 0;
    for (const c of recent) {
      if (c === "W") w++;
      else if (c === "L") l++;
    }
    return w - l;
  };
  const homeScore = formScore(homeForm, homeVenueForm);
  const awayScore = formScore(awayForm, awayVenueForm);
  // Each unit of net form differential = 0.008 shift, capped at ±0.04
  let delta = (homeScore - awayScore) * 0.008;
  delta = Math.max(-0.04, Math.min(0.04, delta));

  // ── Rest-day penalty (A3) ─────────────────────────────────────────────────
  const threshold = ENGINE_CONFIG.REST_PENALTY_THRESHOLD;
  const perDay = ENGINE_CONFIG.REST_PENALTY_PER_DAY;
  const maxPenalty = ENGINE_CONFIG.REST_PENALTY_MAX;
  const restPenalty = (restDays: number | null | undefined): number => {
    if (restDays === null || restDays === undefined) return 0;
    if (restDays >= threshold) return 0;
    const deficit = threshold - restDays;
    return Math.min(maxPenalty, deficit * perDay);
  };
  const homeRestPenalty = restPenalty(restDaysHome);
  const awayRestPenalty = restPenalty(restDaysAway);
  // Apply: home penalty shifts AWAY from home (negative delta), away penalty
  // shifts TOWARD home (positive delta). Net effect = (awayPenalty - homePenalty).
  delta += awayRestPenalty - homeRestPenalty;

  // Final cap at ±0.06 (slightly wider than the old ±0.04 to accommodate rest-day)
  return Math.max(-0.06, Math.min(0.06, delta));
}

function fairOdds(prob: number): number {
  return 1 / clampProb(prob);
}

/**
 * Realistic bookmaker odds — synthesized when no real market odds are available.
 *
 * In real markets, bookmakers build in a margin (overround) that varies by
 * market type:
 *   - Asian Handicap / DNB: 1-2% margin (sharpest markets)
 *   - Over/Under:           3-4% margin
 *   - 1X2:                  4-5% margin (Pinnacle ~2.5%, soft books ~5-6%)
 *   - BTTS:                 4-5% margin
 *   - Correct Score:        6-8% margin (highest — many outcomes)
 *
 * The OLD code applied 5-10% margin uniformly, which was too high and caused
 * every pick to show negative edge (we were comparing fair odds with no margin
 * against book odds with 7% margin — so every pick looked 7% worse than reality).
 *
 * Margin scales DOWN with probability (short-priced favorites get less margin
 * because bookmakers compete on price for popular picks; longshots get more
 * margin because their odds are noisy and less price-sensitive).
 *
 * For very high probabilities (>0.95), naive margin math gives odds below 1.0
 * which is nonsensical — we cap implied probability at 0.95 and floor odds at 1.02.
 */
function bookOdds(prob: number, market: string = "1x2"): number {
  const capped = Math.min(0.95, Math.max(0.05, prob));
  // Base margin by market — sharper markets have less margin
  const baseMargin = MARKET_MARGINS[market] ?? 0.05;
  // Margin scales down with probability: longshots get +2%, short-priced gets -1%
  const marginAdj = Math.max(-0.01, (1 - capped) * 0.03);
  const margin = Math.max(0.01, baseMargin + marginAdj);
  const raw = (1 / capped) * (1 - margin);
  return Math.max(1.02, raw);
}

/**
 * Per-market bookmaker margin assumptions (used when synthesizing odds).
 * Values reflect typical Pinnacle-level margins for sharp markets and
 * soft-book margins for novelty markets.
 */
const MARKET_MARGINS: Record<string, number> = {
  "1x2": 0.045,            // 4.5% — Pinnacle 2.5%, soft books 5-6%
  "asian_handicap": 0.025, // 2.5% — sharpest market
  "ou15": 0.035,           // 3.5%
  "ou25": 0.035,           // 3.5%
  "ou35": 0.04,            // 4.0% — less liquid
  "btts": 0.045,           // 4.5%
  "corners_ou": 0.06,      // 6% — niche market
  "cards_ou": 0.06,        // 6% — niche market
  "correct_score": 0.08,   // 8% — many outcomes, high margin
  "htft": 0.10,            // 10% — 9 outcomes, very high margin
  "win_btts": 0.06,        // 6%
  "bet_builder": 0.05,     // 5% — composite
  // ── Derivative markets (sharper than 1X2 because they reduce outcomes) ─────
  "double_chance": 0.035,  // 3.5% — fewer outcomes (2 of 3), tighter pricing
  "dnb": 0.025,            // 2.5% — binary outcome (conditional on non-draw), very sharp
};

/**
 * Picks the real bookmaker odds for a market+selection from the scraped
 * market odds. Returns null if no real odds are available for this market.
 *
 * Map:
 *   1x2     → home / draw / away
 *   ou25    → over25 / under25
 *   ou15    → over15 / under15  (often missing — falls back to ou25 with adjustment)
 *   ou35    → over35 / under35  (often missing)
 *   btts    → bttsYes / bttsNo
 *
 * For markets we don't have real odds for (AH, corners, cards, htft, etc.),
 * we fall through to synthesized bookOdds().
 */
function realOddsFor(
  marketOdds: MatchContext["marketOdds"],
  market: string,
  selection: string
): number | null {
  if (!marketOdds) return null;
  const sel = selection.toLowerCase();
  switch (market) {
    case "1x2":
      if (sel === "1" || sel === "home") return marketOdds.home ?? null;
      if (sel === "x" || sel === "draw") return marketOdds.draw ?? null;
      if (sel === "2" || sel === "away") return marketOdds.away ?? null;
      return null;
    case "ou25":
      if (sel === "over") return marketOdds.over25 ?? null;
      if (sel === "under") return marketOdds.under25 ?? null;
      return null;
    case "ou15":
      // Often missing — if we have ou25 we can estimate via the over-round
      // but it's safer to fall through to synthesized.
      if (sel === "over" && marketOdds.over15) return marketOdds.over15;
      if (sel === "under" && marketOdds.under15) return marketOdds.under15;
      return null;
    case "ou35":
      if (sel === "over" && marketOdds.over35) return marketOdds.over35;
      if (sel === "under" && marketOdds.under35) return marketOdds.under35;
      return null;
    case "btts":
      if (sel === "yes") return marketOdds.bttsYes ?? null;
      if (sel === "no") return marketOdds.bttsNo ?? null;
      return null;
    default:
      return null;
  }
}

/**
 * Resolves the final bookOdds for a prediction:
 *   1. If real market odds are available for this market+selection → use them.
 *   2. Else synthesize from probability with market-appropriate margin.
 *
 * The `realOddsBoost` (default 0.985) is a 1.5% lift applied to real odds to
 * approximate best-price line shopping across multiple bookmakers. Real
 * bookmaker odds shown to the user should reflect a realistic achievable price,
 * not the worst-case single-book price.
 */
function resolveBookOdds(
  probability: number,
  market: string,
  selection: string,
  marketOdds: MatchContext["marketOdds"],
  realOddsBoost: number = 0.985
): number {
  const real = realOddsFor(marketOdds, market, selection);
  if (real && real > 1.0) {
    // Apply mild boost to approximate best-price across books
    return Math.max(1.02, real * realOddsBoost);
  }
  return bookOdds(probability, market);
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
  // ── A3: Venue-split form + rest days ──────────────────────────────────────
  homeVenueForm?: string | null;
  awayVenueForm?: string | null;
  restDaysHome?: number | null;
  restDaysAway?: number | null;
  // ── D1: H2H head-to-head history (JSON from ESPN) ─────────────────────────
  // Last 10 historical meetings between these two specific teams. Used as a
  // PRIMARY signal (50% weight) in the new 80/20 blend.
  h2hJson?: string | null;
  // ── A2: Elo team-strength prior ───────────────────────────────────────────
  eloPrior?: { pHome: number; pDraw: number; pAway: number; sampleSize: number } | null;
  // ── A1: Bivariate-Poisson / Dixon-Coles goal model fit ────────────────────
  // Set after gen1X2 runs, so genOu/genBtts/genCorrectScore can derive their
  // probabilities from the SAME (λ_home, λ_away) — eliminates cross-market
  // inconsistency. Undefined when no 1X2 signal is available.
  goalModelFit?: GoalModelFit | null;
  // ── B3: Per-(market, league) rolling CLV for the engine's chosen markets ──
  // Key: market name (e.g., "1x2", "ou25"). Value: avgClv (positive = good).
  marketLeagueClv?: Map<string, number> | null;
  /**
   * Real bookmaker odds scraped from external sources, when available.
   * When present, these OVERRIDE the synthesized bookOdds() — they're the
   * actual market price, so we should use them rather than our own
   * synthetic margin calculation.
   *
   * Format matches Match.oddsJson:
   *   { home, draw, away, over25, under25, over15, under15, bttsYes, bttsNo, ... }
   */
  marketOdds?: {
    home?: number | null;
    draw?: number | null;
    away?: number | null;
    over25?: number | null;
    under25?: number | null;
    over15?: number | null;
    under15?: number | null;
    over35?: number | null;
    under35?: number | null;
    bttsYes?: number | null;
    bttsNo?: number | null;
  } | null;
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

// ──────────────────────────────────────────────────────────────────────────────
// D1: 80/20 Research Blend (H2H + Form = 80%, Poisson = 20%)
// ──────────────────────────────────────────────────────────────────────────────
// User-driven rebalance: H2H history + recent form are the PRIMARY drivers
// (80% combined), with the Dixon-Coles Poisson goal model providing the
// remaining 20%. Tipster consensus becomes a small tiebreaker blended on top.
//
// This function takes a TIPSTER-derived 1X2 vector (the old "probBlend") and
// the match context (which carries H2H + form data), and produces a new
// 1X2 vector that respects the 80/20 weighting.
//
// When H2H data is missing (about 70% of matches), the H2H weight is
// reallocated proportionally to FORM + POISSON so the total still = 1.0.
// When FORM data is also missing, more weight goes to POISSON + tipster.
//
// `tipsterVector` is the post-consensus, post-Platt 1X2 vector (pHome/pDraw/pAway).
// `poissonVector` is the goal-model-derived 1X2 vector (computed from λ_home/λ_away).
//   When null, the Poisson weight is reallocated to FORM/H2H.
function computeResearchBlend(
  ctx: MatchContext,
  tipsterVector: { pHome: number; pDraw: number; pAway: number },
  poissonVector: { pHome: number; pDraw: number; pAway: number } | null
): { pHome: number; pDraw: number; pAway: number } {
  // ── Fetch the three research signals ──────────────────────────────────────
  const h2h = h2hProbability(ctx.h2hJson);
  const form = formProbability(
    ctx.homeForm, ctx.awayForm,
    ctx.homeVenueForm, ctx.awayVenueForm
  );

  // ── Compute effective weights (reallocating missing signals) ──────────────
  let wH2H = ENGINE_CONFIG.H2H_WEIGHT;
  let wForm = ENGINE_CONFIG.FORM_WEIGHT;
  let wPoisson = ENGINE_CONFIG.POISSON_WEIGHT;

  // If H2H is missing, redistribute its weight to Form (60%) and Poisson (40%)
  if (!h2h) {
    const redistributed = wH2H;
    wForm += redistributed * 0.60;
    wPoisson += redistributed * 0.40;
    wH2H = 0;
  }
  // If Form is missing, redistribute its weight to H2H (60%) and Poisson (40%)
  if (!form) {
    const redistributed = wForm;
    wH2H += redistributed * 0.60;
    wPoisson += redistributed * 0.40;
    wForm = 0;
  }
  // If Poisson is missing, redistribute its weight to H2H (50%) and Form (50%)
  if (!poissonVector) {
    const redistributed = wPoisson;
    wH2H += redistributed * 0.50;
    wForm += redistributed * 0.50;
    wPoisson = 0;
  }

  // ── Combine the research signals ──────────────────────────────────────────
  let pHome = 0, pDraw = 0, pAway = 0;
  if (h2h) {
    pHome += wH2H * h2h.pHome;
    pDraw += wH2H * h2h.pDraw;
    pAway += wH2H * h2h.pAway;
  }
  if (form) {
    pHome += wForm * form.pHome;
    pDraw += wForm * form.pDraw;
    pAway += wForm * form.pAway;
  }
  if (poissonVector) {
    pHome += wPoisson * poissonVector.pHome;
    pDraw += wPoisson * poissonVector.pDraw;
    pAway += wPoisson * poissonVector.pAway;
  }

  // Normalize (in case weights didn't sum to 1 due to redistribution edge cases)
  const s = pHome + pDraw + pAway;
  if (s > 0) { pHome /= s; pDraw /= s; pAway /= s; }

  // ── Apply tipster tiebreaker (small blend on top) ─────────────────────────
  // Even with the 80/20 research blend, we still want tipster consensus to
  // break ties and catch egregious errors. Blend in at TIPSTER_TIEBREAKER_WEIGHT.
  const wTipster = ENGINE_CONFIG.TIPSTER_TIEBREAKER_WEIGHT;
  const wResearch = 1 - wTipster;
  pHome = wResearch * pHome + wTipster * tipsterVector.pHome;
  pDraw = wResearch * pDraw + wTipster * tipsterVector.pDraw;
  pAway = wResearch * pAway + wTipster * tipsterVector.pAway;

  // Final renormalize
  const s2 = pHome + pDraw + pAway;
  if (s2 > 0) { pHome /= s2; pDraw /= s2; pAway /= s2; }

  return { pHome, pDraw, pAway };
}

/**
 * Helper: derive a 1X2 probability vector from a Dixon-Coles goal model fit.
 * Used to provide the "Poisson component" of the 80/20 research blend.
 *
 * Returns null if no goal model fit is available.
 */
function poissonVectorFromGoalModel(fit: GoalModelFit | null | undefined): { pHome: number; pDraw: number; pAway: number } | null {
  if (!fit) return null;
  // Use the goal model's implied 1X2 probabilities, computed from the
  // Dixon-Coles score matrix (handles low-score correlation correctly).
  try {
    return goalModel1X2(fit);
  } catch {
    return null;
  }
}

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

  // ── Compute TIPSTER-derived 1X2 vector (the "old" probability) ────────────
  // This becomes the tiebreaker signal in the new 80/20 blend.
  const tipster = compute1X2Probabilities(ctx);
  // Fallback: if compute1X2Probabilities returned null (no tipster 1X2 picks),
  // use a neutral baseline. The research blend will dominate.
  const tipsterVector = tipster ?? { pHome: 0.40, pDraw: 0.27, pAway: 0.33 };

  // ── D1: Fit goal model from tipster vector → Poisson 1X2 vector ───────────
  // The goal model gives us the "Poisson component" for the 80/20 blend.
  // Fit (λ_home, λ_away) from the tipster 1X2 vector + O/U 2.5 line if available.
  let poissonVector: { pHome: number; pDraw: number; pAway: number } | null = null;
  let goalModelFit: GoalModelFit | null = null;
  try {
    let pOver25: number | undefined;
    if (ctx.marketOdds?.over25 && ctx.marketOdds.over25 > 1) {
      pOver25 = 1 / ctx.marketOdds.over25;
    }
    goalModelFit = fitGoalModel({
      pHome: tipsterVector.pHome,
      pDraw: tipsterVector.pDraw,
      pAway: tipsterVector.pAway,
      pOver25,
    });
    poissonVector = poissonVectorFromGoalModel(goalModelFit);
  } catch {
    // Goal model fit failed — poissonVector stays null, weight is reallocated.
  }

  // ── D1: Apply the 80/20 research blend ─────────────────────────────────────
  // H2H (50%) + Form (30%) + Poisson (20%) + Tipster tiebreaker (10% on top)
  const blended = computeResearchBlend(ctx, tipsterVector, poissonVector);

  // ── Selection: pick the outcome with the highest blended probability ───────
  // (Old code used weightedMode(picks).selection — tipster-driven. We now use
  // the blended vector, which means H2H/Form can OVERRIDE tipster consensus
  // when the research signals strongly disagree.)
  let selection: "1" | "X" | "2";
  if (blended.pHome >= blended.pDraw && blended.pHome >= blended.pAway) selection = "1";
  else if (blended.pAway >= blended.pHome && blended.pAway >= blended.pDraw) selection = "2";
  else selection = "X";

  let probBlend = selection === "1" ? blended.pHome : selection === "2" ? blended.pAway : blended.pDraw;

  // ── Compute disagreement (stdev of per-source tipster probabilities) ───────
  // Kept from the old code — used for the source-disagreement indicator (C2).
  const probSources = ctx.rawPredictions.filter((r) => r.prediction.probabilities);
  let disagreement: number | undefined;
  if (probSources.length > 0) {
    const perSourceProbs: number[] = [];
    for (const r of probSources) {
      const pr = r.prediction.probabilities!;
      const a = r.calibrationA ?? 1;
      const b = r.calibrationB ?? 0;
      const p = selection === "1" ? pr.home : selection === "2" ? pr.away : pr.draw;
      if (p !== undefined) perSourceProbs.push(applyPlatt(p, a, b));
    }
    if (perSourceProbs.length >= 2) {
      const mean = perSourceProbs.reduce((s, p) => s + p, 0) / perSourceProbs.length;
      const variance = perSourceProbs.reduce((s, p) => s + (p - mean) ** 2, 0) / perSourceProbs.length;
      disagreement = Math.sqrt(variance);
    }
  }

  // sources count (for consensusBoost) — based on tipster picks for the selected outcome
  const sources = picks.filter((p) => p.pick === selection).slice(0, 5).map((p) => ({
    source: p.sourceName,
    pick: p.pick,
    weight: p.weight,
  }));

  // ── Safer / higher-confidence ML layer ──────────────────────────────────────
  // 1. Form adjustment — small additional nudge on top of the blended probability.
  //    The form-model already contributes 30% to the blend, so this is now a
  //    minor fine-tuning (was the primary signal in the old engine).
  let adjustedProb = probBlend;
  if (selection === "1") {
    adjustedProb += formAdjustment(
      ctx.homeForm, ctx.awayForm,
      ctx.homeVenueForm, ctx.awayVenueForm,
      ctx.restDaysHome, ctx.restDaysAway
    );
  } else if (selection === "2") {
    adjustedProb -= formAdjustment(
      ctx.homeForm, ctx.awayForm,
      ctx.homeVenueForm, ctx.awayVenueForm,
      ctx.restDaysHome, ctx.restDaysAway
    );
  }
  // 2. Consensus boost — broad tipster agreement carries real signal.
  adjustedProb += consensusBoost(sources.length);
  // 3. Smart-money nudge — if our pick's book odds is SHORTER than fair odds
  //    (i.e. market agrees with us), we're on the right side; tiny bump.
  const fo0 = 1 / Math.max(0.02, Math.min(0.95, probBlend));
  const bo0 = resolveBookOdds(probBlend, "1x2", selection, ctx.marketOdds);
  if (bo0 < fo0) {
    adjustedProb += 0.01;
  }
  const probability = clampProbHigh(adjustedProb);
  const fo = fairOdds(probability);
  const bo = resolveBookOdds(probability, "1x2", selection, ctx.marketOdds);
  // Persist the goal model fit on the context so genOu/genBtts/genCorrectScore
  // can reuse it (avoids refitting).
  ctx.goalModelFit = goalModelFit;
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
    disagreement,
    sources,
  };
}

/**
 * Compute TIPSTER-derived 1X2 probabilities (pHome, pDraw, pAway).
 *
 * This returns the tipster consensus vector ONLY — it does NOT apply the 80/20
 * research blend. Used by:
 *   - gen1X2 → as input to computeResearchBlend (the tipster tiebreaker signal)
 *   - genDoubleChance / genDnb → for derivative market probabilities
 *
 * D1 upgrade note: derivative markets (Double Chance, DNB) currently use the
 * TIPSTER vector directly, not the blended vector. This is intentional — those
 * markets are derived FROM the 1X2 selection, and we want them to be
 * consistent with the 1X2 pick. The blended probability is applied to the
 * 1X2 prediction itself.
 *
 * Returns null if no sources contributed any 1X2 signal.
 */
function compute1X2Probabilities(ctx: MatchContext): {
  pHome: number;
  pDraw: number;
  pAway: number;
  homePickSources: number;
  awayPickSources: number;
  drawPickSources: number;
} | null {
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
  if (picks.length === 0) return null;

  // ── Mode-based probabilities (counting source weight per pick) ────────────
  const tally: Record<string, { weight: number; sources: number }> = {
    "1": { weight: 0, sources: 0 },
    X: { weight: 0, sources: 0 },
    "2": { weight: 0, sources: 0 },
  };
  for (const p of picks) {
    if (tally[p.pick]) {
      tally[p.pick].weight += p.weight;
      tally[p.pick].sources += 1;
    }
  }
  const totalWeight = picks.reduce((s, p) => s + p.weight, 0) || 1;
  let pHome = tally["1"].weight / totalWeight;
  let pDraw = tally.X.weight / totalWeight;
  let pAway = tally["2"].weight / totalWeight;

  // ── Blend with explicit (calibrated) probabilities if sources expose them ─
  const probSources = ctx.rawPredictions.filter((r) => r.prediction.probabilities);
  if (probSources.length > 0) {
    let sumW = 0;
    let eHome = 0, eDraw = 0, eAway = 0;
    for (const r of probSources) {
      const pr = r.prediction.probabilities!;
      const w = r.weight;
      const a = r.calibrationA ?? 1;
      const b = r.calibrationB ?? 0;
      eHome += applyPlatt(pr.home ?? 0.33, a, b) * w;
      eDraw += applyPlatt(pr.draw ?? 0.33, a, b) * w;
      eAway += applyPlatt(pr.away ?? 0.33, a, b) * w;
      sumW += w;
    }
    if (sumW > 0) {
      eHome /= sumW; eDraw /= sumW; eAway /= sumW;
      const sumP = eHome + eDraw + eAway;
      if (sumP > 0) { eHome /= sumP; eDraw /= sumP; eAway /= sumP; }
      // Blend 40% explicit probabilities with 60% mode-derived
      pHome = 0.6 * pHome + 0.4 * eHome;
      pDraw = 0.6 * pDraw + 0.4 * eDraw;
      pAway = 0.6 * pAway + 0.4 * eAway;
      // Re-normalize after blend
      const s = pHome + pDraw + pAway;
      if (s > 0) { pHome /= s; pDraw /= s; pAway /= s; }
    }
  }

  // ── Apply form adjustment (mirrors gen1X2, A3 upgraded) ───────────────────
  const formAdj = formAdjustment(
    ctx.homeForm, ctx.awayForm,
    ctx.homeVenueForm, ctx.awayVenueForm,
    ctx.restDaysHome, ctx.restDaysAway
  );
  pHome = Math.max(0.05, Math.min(0.92, pHome + formAdj));
  pAway = Math.max(0.05, Math.min(0.92, pAway - formAdj));
  const sumP = pHome + pDraw + pAway;
  if (sumP > 0) { pHome /= sumP; pDraw /= sumP; pAway /= sumP; }

  return {
    pHome,
    pDraw,
    pAway,
    homePickSources: tally["1"].sources,
    awayPickSources: tally["2"].sources,
    drawPickSources: tally.X.sources,
  };
}

/**
 * Double Chance market — 1X / X2 / 12.
 *
 * Each selection covers 2 of 3 outcomes, so the probability is the sum of the
 * two covered outcomes:
 *   - "1X" → P(home win) + P(draw) — wins if home wins OR draw
 *   - "X2" → P(draw) + P(away win) — wins if away wins OR draw
 *   - "12" → P(home win) + P(away win) — wins if either side wins (not draw)
 *
 * Double Chance typically offers odds in the 1.10–1.40 range (very safe but
 * low return). The selection with the highest combined probability is picked.
 *
 * This market is included to give users an explicit "safest possible" option
 * for each match — useful for the Safe Picks tab and as a parlay leg when the
 * user wants near-guaranteed returns.
 */
function genDoubleChance(ctx: MatchContext): EnginePrediction {
  const probs = compute1X2Probabilities(ctx);
  if (!probs) {
    return stub("double_chance", "1X", 0.70);
  }
  const { pHome, pDraw, pAway, homePickSources, awayPickSources, drawPickSources } = probs;
  // Combined probabilities for each DC selection
  const p1X = pHome + pDraw;
  const pX2 = pDraw + pAway;
  const p12 = pHome + pAway;

  // Pick the highest-probability selection (the "safest" double chance)
  let selection: string;
  let prob: number;
  let sources: { source: string; pick: string; weight: number }[];
  // Sources = union of the two contributing pick groups
  const buildSources = (picks1: number, picks2: number) =>
    ctx.rawPredictions
      .filter((r) => r.prediction["1x2"])
      .slice(0, picks1 + picks2)
      .map((r) => ({ source: r.sourceName, pick: `1x2:${r.prediction["1x2"]}`, weight: r.weight }));

  if (p1X >= pX2 && p1X >= p12) {
    selection = "1X";
    prob = p1X;
    sources = buildSources(homePickSources, drawPickSources);
  } else if (pX2 >= p12) {
    selection = "X2";
    prob = pX2;
    sources = buildSources(drawPickSources, awayPickSources);
  } else {
    selection = "12";
    prob = p12;
    sources = buildSources(homePickSources, awayPickSources);
  }

  // DC odds reflect 2-of-3 coverage: very high probability → very low odds.
  // Apply mild margin (4% — typical for DC markets at soft books).
  const adjusted = clampProbHigh(prob + consensusBoost(Math.max(homePickSources, awayPickSources, drawPickSources)));
  const bo = resolveBookOdds(adjusted, "double_chance", selection, ctx.marketOdds);
  return {
    market: "double_chance",
    selection,
    confidence: Math.round(adjusted * 100),
    probability: adjusted,
    fairOdds: fairOdds(adjusted),
    bookOdds: bo,
    edge: edge(adjusted, bo),
    isTopPick: false,
    isValueBet: false,
    isSafePick: false,
    consensusSources: sources.length,
    sources,
  };
}

/**
 * Draw No Bet (DNB) — stake refunded on draw.
 *
 * For a given side (home or away):
 *   - Win if that side wins (full payout at odds)
 *   - Push (refund) if draw (stake returned, no profit)
 *   - Lose if other side wins
 *
 * Effective probability (conditional on non-draw):
 *   P(win | not draw) = P(side win) / (P(side win) + P(other side win))
 *
 * Fair odds = 1 / P(win | not draw) = (P(side) + P(other)) / P(side)
 *
 * DNB odds are typically HIGHER than the corresponding 1X2 odds when the draw
 * probability is significant (e.g. a 1X2 home at 1.80 might be DNB home at
 * 2.20 if draw is ~25%). This is the key insight: DNB removes draw-risk while
 * still offering reasonable odds on the favored side.
 *
 * Selection: we pick whichever side has the higher win probability (mirrors
 * the 1X2 selection but with draw-risk removed).
 */
function genDnb(ctx: MatchContext): EnginePrediction {
  const probs = compute1X2Probabilities(ctx);
  if (!probs) {
    return stub("dnb", `${ctx.homeTeam} DNB`, 0.55);
  }
  const { pHome, pDraw, pAway, homePickSources, awayPickSources } = probs;

  // Pick the stronger side (mirrors 1X2 selection logic)
  const pickHome = pHome >= pAway;
  const sideProb = pickHome ? pHome : pAway;
  const otherProb = pickHome ? pAway : pHome;
  const sideSources = pickHome ? homePickSources : awayPickSources;
  const selection = pickHome
    ? `${ctx.homeTeam} DNB`
    : `${ctx.awayTeam} DNB`;

  // Effective probability conditional on non-draw
  // = P(side wins) / (P(side wins) + P(other wins))
  // = sideProb / (sideProb + otherProb)
  // Apply consensus boost first (consistent with 1X2)
  const adjustedSide = clampProbHigh(sideProb + consensusBoost(sideSources));
  const adjustedOther = clampProbHigh(otherProb);
  const denom = Math.max(0.001, adjustedSide + adjustedOther);
  let effectiveProb = adjustedSide / denom;
  // DNB probabilities are typically 0.55-0.78 for the favored side (higher
  // than straight 1X2 because the draw-risk is removed). Cap at 0.92.
  effectiveProb = Math.max(0.30, Math.min(0.92, effectiveProb));

  // DNB synthesized bookmaker odds use a sharp 2.5% margin (DNB is one of the
  // sharpest markets — bookmakers can't hide much margin since it's a binary
  // outcome conditional on non-draw).
  const bo = resolveBookOdds(effectiveProb, "dnb", selection, ctx.marketOdds);
  const sources = ctx.rawPredictions
    .filter((r) => r.prediction["1x2"] === (pickHome ? "1" : "2"))
    .map((r) => ({ source: r.sourceName, pick: `dnb:${pickHome ? "1" : "2"}`, weight: r.weight }));

  return {
    market: "dnb",
    selection,
    confidence: Math.round(effectiveProb * 100),
    probability: effectiveProb,
    fairOdds: fairOdds(effectiveProb),
    bookOdds: bo,
    edge: edge(effectiveProb, bo),
    isTopPick: false,
    isValueBet: false,
    isSafePick: false,
    consensusSources: sideSources,
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
      bookOdds: resolveBookOdds(prob, "htft", r.selection, ctx.marketOdds),
      edge: edge(prob, resolveBookOdds(prob, "htft", r.selection, ctx.marketOdds)),
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
    bookOdds: resolveBookOdds(prob, "htft", r.selection, ctx.marketOdds),
    edge: edge(prob, resolveBookOdds(prob, "htft", r.selection, ctx.marketOdds)),
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

  // ── A1: Goal-model prior ───────────────────────────────────────────────────
  // If we have a goal model fit, derive BTTS probability from (λ_h, λ_a)
  // instead of using a flat 0.52 base rate. This makes BTTS coherent with
  // the 1X2 prediction (a high-scoring match per 1X2 → higher BTTS yes prob).
  const goalPrior = ctx.goalModelFit ? goalModelBtts(ctx.goalModelFit) : null;
  const goalPriorYes = goalPrior?.pYes;
  const goalPriorNo = goalPrior?.pNo;

  if (picks.length === 0) {
    // No source coverage — use goal model if available, else default
    if (goalPriorYes !== undefined) {
      const selection = goalPriorYes >= 0.5 ? "yes" : "no";
      const prob = clampProb(selection === "yes" ? goalPriorYes : (goalPriorNo ?? 0.48));
      return {
        market: "btts",
        selection,
        confidence: Math.round(prob * 100),
        probability: prob,
        fairOdds: fairOdds(prob),
        bookOdds: resolveBookOdds(prob, "btts", selection, ctx.marketOdds),
        edge: edge(prob, resolveBookOdds(prob, "btts", selection, ctx.marketOdds)),
        isTopPick: false,
        isValueBet: false,
        sources: [],
      };
    }
    // Default — slight lean to "yes"
    return stub("btts", "yes", 0.55);
  }
  const r = weightedMode(picks);
  // BTTS base rate — use goal model if available, else flat 0.52
  const prior = r.selection === "yes"
    ? (goalPriorYes ?? 0.52)
    : (goalPriorNo ?? 0.48);
  // Blend: goal model gets GOALMODEL_PRIOR_WEIGHT when available
  let prob: number;
  if (ctx.goalModelFit) {
    const goalProb = r.selection === "yes" ? goalPriorYes! : goalPriorNo!;
    const w = ENGINE_CONFIG.GOALMODEL_PRIOR_WEIGHT;
    const blended = r.probability * (1 - w) + goalProb * w;
    prob = clampProb(blended);
  } else {
    prob = clampProb(blendWithPrior(r.probability, picks.length, prior));
  }
  return {
    market: "btts",
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: resolveBookOdds(prob, "btts", r.selection, ctx.marketOdds),
    edge: edge(prob, resolveBookOdds(prob, "btts", r.selection, ctx.marketOdds)),
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
    bookOdds: resolveBookOdds(prob, "win_btts", selection, ctx.marketOdds),
    edge: edge(prob, resolveBookOdds(prob, "win_btts", selection, ctx.marketOdds)),
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

  // ── A1: Goal-model prior for O/U ───────────────────────────────────────────
  // If we have a goal model fit, derive P(over) from (λ_h + λ_a) instead of
  // flat base rates. This makes O/U 1.5, 2.5, 3.5 all coherent with each
  // other AND with the 1X2 prediction.
  const goalPrior = ctx.goalModelFit ? goalModelOverUnder(ctx.goalModelFit, line) : null;
  const goalPriorOver = goalPrior?.pOver;
  const goalPriorUnder = goalPrior?.pUnder;

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
        // Base rates — use goal model if available, else flat
        const basePrior = goalPriorOver ?? (line === 1.5 ? 0.80 : line === 3.5 ? 0.30 : 0.55);
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
          bookOdds: resolveBookOdds(prob, market, r.selection, ctx.marketOdds),
          edge: edge(prob, resolveBookOdds(prob, market, r.selection, ctx.marketOdds)),
          isTopPick: false,
          isValueBet: false,
          sources: r.sources,
        };
      }
    }
    // No source coverage — use goal model if available
    if (goalPriorOver !== undefined) {
      const selection = goalPriorOver >= 0.5 ? "over" : "under";
      const prob = clampProb(selection === "over" ? goalPriorOver : (goalPriorUnder ?? 0.5));
      return {
        market,
        selection,
        confidence: Math.round(prob * 100),
        probability: prob,
        fairOdds: fairOdds(prob),
        bookOdds: resolveBookOdds(prob, market, selection, ctx.marketOdds),
        edge: edge(prob, resolveBookOdds(prob, market, selection, ctx.marketOdds)),
        isTopPick: false,
        isValueBet: false,
        sources: [],
      };
    }
    return stub(market, line === 1.5 ? "over" : line === 3.5 ? "under" : "over", line === 1.5 ? 0.75 : line === 3.5 ? 0.35 : 0.55);
  }
  const r = weightedMode(picks);
  // Base rates — use goal model if available, else flat
  const basePrior = goalPriorOver ?? (line === 1.5 ? 0.80 : line === 3.5 ? 0.30 : 0.55);
  const prior = r.selection === "over" ? basePrior : 1 - basePrior;
  // Blend: goal model gets GOALMODEL_PRIOR_WEIGHT when available
  let prob: number;
  if (ctx.goalModelFit) {
    const goalProb = r.selection === "over" ? goalPriorOver! : goalPriorUnder!;
    const w = ENGINE_CONFIG.GOALMODEL_PRIOR_WEIGHT;
    const blended = r.probability * (1 - w) + goalProb * w;
    prob = clampProb(blended);
  } else {
    prob = clampProb(blendWithPrior(r.probability, picks.length, prior));
  }
  return {
    market,
    selection: r.selection,
    confidence: Math.round(prob * 100),
    probability: prob,
    fairOdds: fairOdds(prob),
    bookOdds: resolveBookOdds(prob, market, r.selection, ctx.marketOdds),
    edge: edge(prob, resolveBookOdds(prob, market, r.selection, ctx.marketOdds)),
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
    bookOdds: resolveBookOdds(prob, "asian_handicap", r.selection, ctx.marketOdds),
    edge: edge(prob, resolveBookOdds(prob, "asian_handicap", r.selection, ctx.marketOdds)),
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
    bookOdds: resolveBookOdds(prob, "corners_ou", r.selection, ctx.marketOdds),
    edge: edge(prob, resolveBookOdds(prob, "corners_ou", r.selection, ctx.marketOdds)),
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
    bookOdds: resolveBookOdds(prob, "corners_first", r.selection, ctx.marketOdds),
    edge: edge(prob, resolveBookOdds(prob, "corners_first", r.selection, ctx.marketOdds)),
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
    bookOdds: resolveBookOdds(prob, "cards_ou", r.selection, ctx.marketOdds),
    edge: edge(prob, resolveBookOdds(prob, "cards_ou", r.selection, ctx.marketOdds)),
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

  // ── A1: Goal-model prior for correct score ─────────────────────────────────
  // If we have a goal model fit, use the Dixon-Coles score matrix to pick the
  // most likely score. This is much more accurate than the old approach of
  // just trusting tipster picks (which are noisy and often disagree).
  if (ctx.goalModelFit) {
    const mostLikely = goalModelMostLikelyScore(ctx.goalModelFit);
    // If tipster picks agree with the goal model, boost the probability;
    // otherwise use the goal model's probability (capped at 18%).
    const tipsterAgrees = picks.length > 0 && picks.some((p) => p.pick === mostLikely.score);
    const agreementBoost = tipsterAgrees ? 1.15 : 1.0;
    const prob = clampProb(Math.min(0.18, mostLikely.probability * agreementBoost));
    const sources = picks.length > 0
      ? weightedMode(picks).sources
      : [{ source: "engine", pick: `goal_model:${mostLikely.score}`, weight: 1 }];
    return {
      market: "correct_score",
      selection: mostLikely.score,
      confidence: Math.round(prob * 100),
      probability: prob,
      fairOdds: fairOdds(prob),
      bookOdds: resolveBookOdds(prob, "correct_score", mostLikely.score, ctx.marketOdds),
      edge: edge(prob, resolveBookOdds(prob, "correct_score", mostLikely.score, ctx.marketOdds)),
      isTopPick: false,
      isValueBet: false,
      sources,
    };
  }
  // Fallback: no goal model — use tipster picks
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
    bookOdds: resolveBookOdds(prob, "correct_score", r.selection, ctx.marketOdds),
    edge: edge(prob, resolveBookOdds(prob, "correct_score", r.selection, ctx.marketOdds)),
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
  const bo = bookOdds(p, market); // stub never has real marketOdds — always synthesized
  return {
    market,
    selection,
    confidence: Math.round(p * 100),
    probability: p,
    fairOdds: fairOdds(p),
    bookOdds: bo,
    edge: edge(p, bo),
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
 * A1: Fit the Bivariate-Poisson / Dixon-Coles goal model from a 1X2 prediction
 * and (optionally) the O/U 2.5 line.
 *
 * The goal model gives us coherent (λ_home, λ_away) that we can use to derive
 * O/U, BTTS, and correct score probabilities consistently — eliminating cross-
 * market inconsistency where O2.5 and BTTS could previously disagree about
 * the same match's expected goals.
 *
 * Returns null if no 1X2 signal is available.
 */
function fitGoalModelFrom1X2(ctx: MatchContext, pred1X2: EnginePrediction): GoalModelFit | null {
  // Reconstruct the full 1X2 probability triple. pred1X2 gives us only the
  // SELECTION's probability — we need all three outcomes. Recompute via
  // compute1X2Probabilities.
  const probs = compute1X2Probabilities(ctx);
  if (!probs) return null;

  // Optional: pull O/U 2.5 line from real market odds if available
  let pOver25: number | undefined;
  if (ctx.marketOdds?.over25 && ctx.marketOdds.over25 > 1) {
    // Convert book odds → implied probability (remove margin)
    pOver25 = 1 / ctx.marketOdds.over25;
  }

  const fit = fitGoalModel({
    pHome: probs.pHome,
    pDraw: probs.pDraw,
    pAway: probs.pAway,
    pOver25,
  });
  return fit;
}

/**
 * Builds the full set of compound predictions for a single match.
 *
 * A1 upgrade: Bivariate-Poisson / Dixon-Coles goal model. After computing
 * the 1X2 prediction (which uses tipster consensus + form + Elo + CLV), we
 * fit (λ_home, λ_away) from the 1X2 probability triple + O/U 2.5 line, then
 * use the goal model as a PRIOR for goal-derived markets (O/U, BTTS, CS).
 *
 * This eliminates cross-market inconsistency (today O2.5 and BTTS can
 * disagree about the same match's expected goals) and is the documented
 * gold standard for soccer modelling.
 */
export function buildPredictionsForMatch(ctx: MatchContext): EnginePrediction[] {
  const preds: EnginePrediction[] = [];
  // gen1X2 now fits the goal model internally (needed for the 80/20 research
  // blend's Poisson component) and stores it on ctx.goalModelFit.
  const pred1X2 = gen1X2(ctx);
  preds.push(pred1X2);

  // ── A1: Goal model is already fit inside gen1X2 (D1 upgrade) ──────────────
  // gen1X2 fits (λ_home, λ_away) from the tipster 1X2 vector + O/U 2.5 line,
  // uses it as the Poisson component of the blend, and persists the fit on
  // ctx.goalModelFit so genOu/genBtts/genCorrectScore can reuse the same fit.
  const ctxWithGoal: MatchContext = ctx;

  // Derivative markets derived from 1X2 probabilities — these give users
  // alternative ways to bet the same prediction. Double Chance is the safest
  // (lowest odds, highest probability); DNB removes draw-risk while keeping
  // reasonable odds (often HIGHER than straight 1X2 for the favored side).
  preds.push(genDoubleChance(ctxWithGoal));
  preds.push(genDnb(ctxWithGoal));
  preds.push(genHtFt(ctxWithGoal));
  preds.push(genBtts(ctxWithGoal));
  preds.push(genWinBtts(ctxWithGoal));
  preds.push(genOu(ctxWithGoal, "ou15", 1.5));
  preds.push(genOu(ctxWithGoal, "ou25", 2.5));
  preds.push(genOu(ctxWithGoal, "ou35", 3.5));
  preds.push(genAsianHandicap(ctxWithGoal));
  preds.push(genCornersOu(ctxWithGoal));
  preds.push(genCornersFirst(ctxWithGoal));
  preds.push(genCardsOu(ctxWithGoal));
  preds.push(genCorrectScore(ctxWithGoal));
  // Bet builder uses the others
  preds.push(genBetBuilder(ctxWithGoal, preds));

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
    // DNB is effectively binary (win or push/lose — push treated as non-loss)
    "dnb",
  ]);
  for (const p of preds) {
    // consensusSources — populated by gen1X2 above; for other markets infer
    // from sources.length
    if (p.consensusSources === undefined) {
      p.consensusSources = p.sources.length;
    }
    // Apply consensus boost to non-1X2 markets too (1X2 already done above)
    if (p.market !== "1x2" && p.market !== "double_chance" && p.market !== "dnb" && p.consensusSources > 0) {
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
      p.edge = edge(p.probability, p.bookOdds ?? bookOdds(p.probability, p.market));
    }
    // isSafePick — true when this pick is the lower-risk side of its market.
    // For binary markets, the engine's pick is "safe" if its probability is
    // >= 0.55 (clear lean). For 1X2, "safe" if probability >= 0.50 (favorite).
    // Double Chance is ALWAYS safe (covers 2 of 3 outcomes).
    // DNB is safe if conditional prob >= 0.55 (clear favorite after removing draw).
    // Combo / synthetic markets are never marked safe.
    if (BINARY_MARKETS.has(p.market)) {
      p.isSafePick = p.probability >= 0.55;
    } else if (p.market === "1x2") {
      p.isSafePick = p.probability >= 0.50;
    } else if (p.market === "double_chance") {
      // Double Chance covers 2 of 3 outcomes — always the safest pick
      p.isSafePick = p.probability >= 0.65;
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
  //
  // ── Odds-aware bonus (NEW) ──────────────────────────────────────────────────
  // To surface picks with HIGHER ODDS without sacrificing safety, we add a
  // bonus to picks whose bookOdds fall in the "safe high-odds" band
  // [SAFE_HIGH_ODDS_MIN_ODDS, SAFE_HIGH_ODDS_MAX_ODDS] (default 1.50–2.50).
  // Picks in this band get a +0.04 bonus (comparable to the safe-pick bonus)
  // — enough to break ties in favor of higher-odds picks but not enough to
  // override a clearly safer low-odds favorite.
  const EXCLUDED_TOP_PICK_MARKETS = new Set(["bet_builder", "win_btts", "correct_score", "htft"]);
  const eligible = preds.filter((p) => !EXCLUDED_TOP_PICK_MARKETS.has(p.market));
  if (eligible.length > 0) {
    const TOP_PICK_MIN_PROB = ENGINE_CONFIG.TOP_PICK_MIN_PROB;
    const SWEET_LOW = ENGINE_CONFIG.TOP_PICK_SWEET_LOW;
    const SWEET_HIGH = ENGINE_CONFIG.TOP_PICK_SWEET_HIGH;
    const SHO_MIN_ODDS = ENGINE_CONFIG.SAFE_HIGH_ODDS_MIN_ODDS;
    const SHO_MAX_ODDS = ENGINE_CONFIG.SAFE_HIGH_ODDS_MAX_ODDS;
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
        // ── Odds-aware bonus — reward picks in the safe-high-odds band ───────
        // This nudges the top-pick selection toward higher-odds picks when
        // they're equally safe, so users see picks with meaningful upside
        // (1.50–2.50 odds) instead of just low-odds heavy favorites.
        const odds = p.bookOdds ?? 0;
        const highOddsBonus =
          odds >= SHO_MIN_ODDS && odds <= SHO_MAX_ODDS ? 0.04 : 0;
        return { p, score: probScore + edgeBonus + consensusScore + safeBonus + highOddsBonus };
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
  //   4. Bookmaker odds ≥ VALUE_BET_MIN_ODDS (default 1.45) — exclude low-odds
  //      "value" picks (e.g. O1.5 at 1.20) where the risk/reward is poor even
  //      with positive edge. A 1.20-odds pick needs 5 wins to offset 1 loss.
  //   5. Exclude combo markets (bet_builder, correct_score, htft) — too noisy.
  //
  // Consensus bonus still applies: 3+ agreeing sources add +0.04 to edge,
  // 2 sources add +0.02. This rewards broad agreement beyond the hard filter.
  for (const p of preds) {
    const sources = p.sources.length;
    const consensusBonus = sources >= 3 ? 0.04 : sources >= 2 ? 0.02 : 0;
    const adjustedEdge = (p.edge ?? 0) + consensusBonus;
    p.edge = adjustedEdge;
    const odds = p.bookOdds ?? 0;
    if (
      adjustedEdge > ENGINE_CONFIG.VALUE_BET_MIN_EDGE &&
      p.probability >= ENGINE_CONFIG.VALUE_BET_MIN_PROB &&
      p.probability <= ENGINE_CONFIG.VALUE_BET_MAX_PROB &&
      (p.consensusSources ?? 0) >= ENGINE_CONFIG.VALUE_BET_MIN_SOURCES &&
      odds >= ENGINE_CONFIG.VALUE_BET_MIN_ODDS &&
      p.market !== "bet_builder" &&
      p.market !== "correct_score" &&
      p.market !== "htft"
    ) {
      p.isValueBet = true;
    }
  }

  // ── Safest High-Odds tier ───────────────────────────────────────────────────
  // A STRICTER tier than value bets: surfaces picks that combine HIGHER ODDS
  // (1.50–2.50) with ALL safety precautions. These are the investment-grade
  // picks the user sees in the "Safe High-Odds" tab.
  //
  // Criteria (ALL must hold — see ENGINE_CONFIG.SAFE_HIGH_ODDS_*):
  //   1. bookOdds in [SAFE_HIGH_ODDS_MIN_ODDS, SAFE_HIGH_ODDS_MAX_ODDS]
  //   2. probability ≥ SAFE_HIGH_ODDS_MIN_PROB (still safe)
  //   3. consensus ≥ SAFE_HIGH_ODDS_MIN_SOURCES (multi-source agreement)
  //   4. edge ≥ SAFE_HIGH_ODDS_MIN_EDGE (well above noise)
  //   5. Kelly stake > 0 (positive expected value — checked against a 1/4
  //      fractional Kelly on the bookOdds)
  //   6. Safe market only — 1X2, O/U 2.5/3.5, BTTS, AH, Double Chance, DNB
  //   7. B3 NEW: per-(market, league) CLV ≥ MARKET_LEAGUE_MIN_CLV (don't
  //      recommend investment-grade picks on combos where we systematically
  //      lose to the closing line)
  //   8. C2 NEW: disagreement ≤ SAFE_HIGH_ODDS_MAX_DISAGREEMENT (don't
  //      recommend picks where sources strongly disagree)
  //
  // Note: Safe High-Odds picks are ALSO flagged as value bets (they always
  // clear the value-bet thresholds). The isSafeHighOdds flag is a STRICTER
  // subset — UI shows them in a dedicated tab so users can find higher-odds
  // investment-grade picks at a glance.
  const SAFE_HIGH_ODDS_MARKETS = new Set([
    "1x2",
    "ou25",
    "ou35",
    "btts",
    "asian_handicap",
    "double_chance",
    "dnb",
  ]);
  for (const p of preds) {
    if (!SAFE_HIGH_ODDS_MARKETS.has(p.market)) continue;
    const odds = p.bookOdds ?? 0;
    if (odds < ENGINE_CONFIG.SAFE_HIGH_ODDS_MIN_ODDS) continue;
    if (odds > ENGINE_CONFIG.SAFE_HIGH_ODDS_MAX_ODDS) continue;
    if (p.probability < ENGINE_CONFIG.SAFE_HIGH_ODDS_MIN_PROB) continue;
    if ((p.consensusSources ?? 0) < ENGINE_CONFIG.SAFE_HIGH_ODDS_MIN_SOURCES) continue;
    if ((p.edge ?? 0) < ENGINE_CONFIG.SAFE_HIGH_ODDS_MIN_EDGE) continue;
    // ── B3: CLV gate — exclude (market, league) combos we systematically lose ──
    if (ctx.marketLeagueClv) {
      const leagueId = ctx.leagueId ?? "none";
      const clvKey = `${p.market}|${leagueId}`;
      const mlClv = ctx.marketLeagueClv.get(clvKey);
      if (mlClv !== undefined && mlClv < ENGINE_CONFIG.MARKET_LEAGUE_MIN_CLV) {
        continue;
      }
    }
    // ── C2: Disagreement gate — exclude "lottery" picks ───────────────────────
    if (p.disagreement !== undefined && p.disagreement > ENGINE_CONFIG.SAFE_HIGH_ODDS_MAX_DISAGREEMENT) {
      continue;
    }
    // Kelly check — full Kelly must be positive (positive expected value)
    if (p.bookOdds && p.bookOdds > 1) {
      const k = kellyStake(p.probability, p.bookOdds);
      if (k.fullKelly <= 0) continue;
    } else {
      continue;
    }
    p.isSafeHighOdds = true;
    // Safe high-odds picks are ALSO value bets (they clear all value-bet
    // thresholds by construction: edge ≥ 4% > 2.5%, prob in band, sources ≥ 2).
    if (!p.isValueBet) p.isValueBet = true;
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
export async function generatePredictionsForDate(
  dateStr: string,
  options?: { force?: boolean }
): Promise<{
  matches: number;
  predictions: number;
  skipped?: number;
  riskGate?: {
    drawdownState: DrawdownState;
    stakeMultiplier: number;
    portfolioScale: number;
    totalExposure: number;
    reason: string;
  };
}> {
  const force = options?.force === true;
  const matches = await db.match.findMany({
    where: { matchDate: dateStr },
    include: {
      rawPredictions: { include: { source: true } },
    },
  });

  let totalPredictions = 0;
  let skippedMatches = 0;

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

  // ── B3: Load per-(market, league) CLV map for the safe-high-odds gate ──────
  const marketLeagueClvMap = await loadMarketLeagueClvMap();

  // ── A2: Load Elo priors for each match in parallel ────────────────────────
  // For each match, look up the home/away team's Elo rating in the match's
  // league and compute the implied 1X2 probabilities. Stored in a map keyed
  // by matchId so the per-match loop can fetch it in O(1).
  const eloPriorMap = new Map<string, { pHome: number; pDraw: number; pAway: number; sampleSize: number }>();
  await Promise.all(matches.map(async (m) => {
    try {
      const elo = await loadEloProbability(m.homeTeam, m.awayTeam, m.leagueId);
      if (elo) eloPriorMap.set(m.id, elo);
    } catch {
      // Elo lookup failed (e.g., DB not initialized yet) — skip silently
    }
  }));

  // ── Load drawdown state (B2) ───────────────────────────────────────────────
  // Read previous state + recent snapshots to decide if we're in a bad regime.
  const drawdownInfo = await loadDrawdownContext();
  const drawdownDecision = computeDrawdownState(drawdownInfo);
  // Persist the new state for the next run to read.
  await db.modelState.upsert({
    where: { key: "drawdown_state" },
    create: {
      key: "drawdown_state",
      value: drawdownStateToValue(drawdownDecision.state),
      notes: drawdownDecision.reason,
    },
    update: {
      value: drawdownStateToValue(drawdownDecision.state),
      notes: drawdownDecision.reason,
    },
  });

  // ── Phase 1: build all predictions in memory (don't persist yet) ───────────
  // We need to see ALL recommended stakes before applying the portfolio cap.
  interface PendingPrediction {
    matchId: string;
    market: string;
    selection: string;
    confidence: number;
    probability: number;
    fairOdds: number;
    bookOdds: number | null;
    edge: number | null;
    isTopPick: boolean;
    isValueBet: boolean;
    isSafePick: boolean;
    isSafeHighOdds: boolean;
    consensusSources: number;
    disagreement: number | null;
    kellyFraction: number | null;
    recommendedStake: number | null;
    sourcesJson: string;
  }
  const pending: PendingPrediction[] = [];

  for (const match of matches) {
    // ── Immutability guard ───────────────────────────────────────────────────
    // Once a prediction has been officially made (persisted + displayed), it
    // must NOT be mutated by subsequent pipeline runs. The user relies on
    // the values shown at first-display time for their bet tracking — if
    // confidence / odds / Kelly stake / flags silently shift on the next
    // refresh, the displayed picks become unreliable.
    //
    // Default behavior (force=false): if any predictions already exist for
    // this match, skip the match entirely. New matches without predictions
    // still get them; matches with predictions are frozen.
    //
    // Escape hatch (force=true): admin can pass `?force=true` to
    // /api/trigger?phase=predict to rebuild predictions for the date. This
    // wipes existing predictions for the match (including result fields —
    // only use when the match has NOT been played yet).
    const existing = await db.prediction.findFirst({
      where: { matchId: match.id },
      select: { id: true },
    });
    if (existing && !force) {
      skippedMatches++;
      continue;
    }
    if (existing && force) {
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
      // ── A3: venue-split form + rest days ──────────────────────────────────
      homeVenueForm: (match as { homeVenueForm?: string | null }).homeVenueForm ?? null,
      awayVenueForm: (match as { awayVenueForm?: string | null }).awayVenueForm ?? null,
      restDaysHome: (match as { restDaysHome?: number | null }).restDaysHome ?? null,
      restDaysAway: (match as { restDaysAway?: number | null }).restDaysAway ?? null,
      // ── D1: H2H historical matchups (ESPN headToHeadGames) ────────────────
      h2hJson: (match as { h2hJson?: string | null }).h2hJson ?? null,
      // ── A2: Elo prior — loaded per match (teams + league) ─────────────────
      eloPrior: eloPriorMap.get(match.id) ?? null,
      // ── B3: market-league CLV map for safe-high-odds gate ────────────────
      marketLeagueClv: marketLeagueClvMap,
      // Parse real market odds from oddsJson — these OVERRIDE synthesized
      // bookOdds whenever a market+selection match is available.
      marketOdds: parseMarketOdds(match.oddsJson),
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

      pending.push({
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
        isSafeHighOdds: p.isSafeHighOdds ?? false,
        consensusSources: p.consensusSources ?? 0,
        disagreement: p.disagreement ?? null,
        kellyFraction,
        recommendedStake,
        sourcesJson: JSON.stringify(p.sources),
      });
    }
  }

  // ── Phase 2: Apply drawdown multiplier (B2) ────────────────────────────────
  // Every recommended stake is scaled by the drawdown multiplier. In "halted"
  // state, all stakes become 0 (predictions still generated, just no bet size).
  for (const p of pending) {
    if (p.recommendedStake !== null && p.recommendedStake !== undefined) {
      p.recommendedStake = p.recommendedStake * drawdownDecision.stakeMultiplier;
      // If drawdown halted, force zero (don't null — UI needs to see "0%" not "—")
      if (drawdownDecision.state === "halted") {
        p.recommendedStake = 0;
      }
    }
  }

  // ── Phase 3: Apply portfolio daily cap (B1) ────────────────────────────────
  // Sum the recommended stakes across all bets (top picks + value bets). If
  // the sum exceeds DAILY_MAX_EXPOSURE, scale every stake pro-rata.
  const betStakes = pending
    .filter((p) => p.isTopPick || p.isValueBet)
    .map((p) => ({ recommendedStake: (p.recommendedStake ?? 0) as number }));
  const portfolioResult = applyPortfolioCap(betStakes);

  // Write back the portfolio-capped stakes
  let betIdx = 0;
  for (const p of pending) {
    if (p.isTopPick || p.isValueBet) {
      p.recommendedStake = portfolioResult.adjustments[betIdx].recommendedStake;
      betIdx++;
    }
  }

  // ── Phase 4: Persist all predictions ───────────────────────────────────────
  for (const p of pending) {
    await db.prediction.create({
      data: {
        matchId: p.matchId,
        market: p.market,
        selection: p.selection,
        confidence: p.confidence,
        probability: p.probability,
        fairOdds: p.fairOdds,
        bookOdds: p.bookOdds,
        edge: p.edge,
        isTopPick: p.isTopPick,
        isValueBet: p.isValueBet,
        isSafePick: p.isSafePick,
        isSafeHighOdds: p.isSafeHighOdds,
        consensusSources: p.consensusSources,
        disagreement: p.disagreement,
        kellyFraction: p.kellyFraction,
        recommendedStake: p.recommendedStake,
        sourcesJson: p.sourcesJson,
      },
    });
    totalPredictions++;
  }

  return {
    matches: matches.length,
    predictions: totalPredictions,
    skipped: skippedMatches,
    riskGate: {
      drawdownState: drawdownDecision.state,
      stakeMultiplier: drawdownDecision.stakeMultiplier,
      portfolioScale: portfolioResult.scaleFactor,
      totalExposure: portfolioResult.totalExposure,
      reason: drawdownDecision.reason,
    },
  };
}

// ── Helpers for B2 drawdown state loading/persistence ─────────────────────────

function drawdownStateToValue(state: DrawdownState): number {
  switch (state) {
    case "normal": return 0;
    case "degraded": return 1;
    case "halted": return 2;
  }
}

function valueToDrawdownState(v: number): DrawdownState {
  if (v >= 2) return "halted";
  if (v >= 1) return "degraded";
  return "normal";
}

async function loadDrawdownContext(): Promise<{
  loseStreak: number;
  winStreak: number;
  peakRoi: number;
  currentRoi: number;
  previousState: DrawdownState;
}> {
  // Previous state from ModelState
  const stateRow = await db.modelState.findUnique({ where: { key: "drawdown_state" } });
  const previousState: DrawdownState = stateRow
    ? valueToDrawdownState(stateRow.value)
    : "normal";

  // Recent snapshots for streak + drawdown computation
  const recent = await db.performanceSnapshot.findMany({
    orderBy: { date: "desc" },
    take: 30,
  });

  // Streaks — count from most recent backwards
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

  // Rolling-7-day kellyRoi (peak vs current) for drawdown measurement.
  // Use the latest 7 snapshots' kellyRoi values; peak = max, current = avg.
  const last7 = recent.slice(0, 7);
  const rois = last7.map((s) => s.kellyRoi ?? 0);
  const peakRoi = rois.length > 0 ? Math.max(...rois) : 0;
  const currentRoi = rois.length > 0 ? rois.reduce((s, r) => s + r, 0) / rois.length : 0;

  return {
    loseStreak,
    winStreak,
    peakRoi,
    currentRoi,
    previousState,
  };
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
 * Parses Match.oddsJson into a market odds lookup object.
 *
 * The oddsJson field is populated by scrapers (forebet, windrawwin, etc.)
 * with whatever real bookmaker odds they could extract for each match.
 * The shape is loose — different scrapers contribute different keys — so
 * we coerce into a normalized structure.
 *
 * Supported keys (any subset may be present):
 *   home, draw, away            — 1X2 odds
 *   over25, under25             — Over/Under 2.5 goals
 *   over15, under15             — Over/Under 1.5 goals
 *   over35, under35             — Over/Under 3.5 goals
 *   bttsYes, bttsNo             — Both Teams To Score
 *
 * Returns null if oddsJson is missing or unparseable.
 */
export function parseMarketOdds(oddsJson: string | null): MatchContext["marketOdds"] {
  if (!oddsJson) return null;
  try {
    const raw = JSON.parse(oddsJson) as Record<string, unknown>;
    const num = (v: unknown): number | null => {
      if (typeof v === "number" && v > 1.0 && Number.isFinite(v)) return v;
      return null;
    };
    return {
      home: num(raw.home),
      draw: num(raw.draw),
      away: num(raw.away),
      over25: num(raw.over25),
      under25: num(raw.under25),
      over15: num(raw.over15),
      under15: num(raw.under15),
      over35: num(raw.over35),
      under35: num(raw.under35),
      bttsYes: num(raw.bttsYes),
      bttsNo: num(raw.bttsNo),
    };
  } catch {
    return null;
  }
}

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
