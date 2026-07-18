/**
 * ML-Driven Parlay Selection (De-correlated v2)
 * ──────────────────────────────────────────────
 * Replaces the naive `probability × confidence` ranking used by the parlay
 * builder with an ML reliability score that combines SIX de-correlated signals:
 *
 *   1. Calibrated probability (Platt-scaled per source, then weighted-averaged)
 *   2. Source cohesion — multi-source agreement AND low disagreement, combined
 *      via geometric mean so a leg needs BOTH to score high. (Collapses the
 *      previously-correlated `consensus` and `lowDisagreement` signals.)
 *   3. Per-(market, league) historical CLV (does this combo beat the closing line?)
 *   4. Source quality — per-source Brier AND CLV combined via geometric mean.
 *      (Collapses the previously-correlated `sourceBrier` and `sourceClv`.)
 *   5. Per-tier historical win rate (Bayesian prior from ParlayTierStats)
 *   6. Past H2H agreement — DOMINANT safety signal. Market-aware: 1X2/DC/DNB
 *      use direct H2H probabilities, OU markets use H2H avg goals, BTTS uses
 *      H2H both-scored %.
 *
 * ─── WHY THE DE-CORRELATION ─────────────────────────────────────────────────
 * v1 had 8 components, but two pairs were mathematically related:
 *   - `consensus` (# sources) and `lowDisagreement` (1 - stdev) are linked:
 *     more sources agreeing → lower stdev by construction.
 *   - `sourceBrier` (calibration) and `sourceClv` (sharpness) both measure
 *     "source quality" and overlap heavily in practice.
 * Counting both members of a correlated pair double-counts the same signal.
 * The v2 model collapses each pair into a single component using geometric
 * mean — which requires BOTH sub-signals to be strong for the combined
 * component to score well. This:
 *   - Removes the double-counting bias.
 *   - Tightens the model (6 effective signals instead of 8 noisy ones).
 *   - Frees weight budget that we redirect into H2H (the dominant safety
 *     signal the user explicitly asked for).
 *
 * For backward compatibility (UI tooltips, persisted componentsJson), the
 * individual sub-signals are STILL computed and exposed on `components` —
 * but the WEIGHTED SUM uses the collapsed aggregates.
 *
 * The model is SELF-LEARNING: after every parlay settles, the feedback loop
 * calls `updateParlayTierStats()` which updates the rolling win rate. The next
 * time parlays are built, `bayesianCombinedProb()` blends the theoretical
 * probability with the observed tier win rate — so over time the model shifts
 * from "trust the math" to "trust the data".
 *
 * Cold-start behaviour: when a tier has <5 settled samples, we use 100% the
 * theoretical probability. As samples accumulate, the Bayesian posterior takes
 * over. By ~30 samples the posterior is ~75% data-driven.
 */

import { db } from "@/lib/db";
import { applyPlatt, sigmoid } from "./calibration";
import { computeH2HAgreement, type H2HAgreementResult } from "@/lib/prediction/h2h";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface LegInput {
  predictionId: string;
  matchId: string;
  matchLabel: string;
  market: string;
  selection: string;
  odds: number;
  probability: number; // raw engine probability (already weighted ensemble)
  confidence: number;  // 0-100
  consensusSources: number;
  disagreement: number | null;
  /** Per-source info needed to compute weighted calibrated probability. */
  sources: Array<{
    sourceId: string;
    weight: number;       // source weight [0.1, 0.95]
    brier30d: number;     // 0 (perfect) to 0.25 (random)
    clv30d: number;       // positive = good
    calibrationA: number; // Platt a
    calibrationB: number; // Platt b
    /** Source's stated probability for THIS selection (raw, before Platt). */
    rawProb: number;
  }>;
  leagueId: string | null;
  /** Pre-looked-up CLV for this (market, league) pair. */
  marketLeagueClv: number | null;
  /** Past head-to-head JSON from ESPN summary (stored on Match.h2hJson). */
  h2hJson?: string | null;
}

export interface LegMLScore {
  /** ML reliability score in [0, 1] — higher = safer leg. */
  reliability: number;
  /** Platt-calibrated probability (per-source weighted average, then Platt). */
  calibratedProb: number;
  /** ML-adjusted probability used for parlay math. */
  adjustedProb: number;
  /** Per-component breakdown for audit + UI tooltip.
   *
   * Includes BOTH the v2 aggregated components (used in the weighted sum) AND
   * the v1 sub-components (for backward-compatible UI display). The aggregated
   * fields are: `sourceCohesion`, `sourceQuality`. The legacy fields are kept
   * so persisted Parlay rows from before the de-correlation still render.
   */
  components: {
    prob: number;            // calibrated prob component (0-1)
    // ── v2 aggregated components (used in weighted sum) ──
    sourceCohesion: number;  // geom mean of consensus × lowDisagreement
    sourceQuality: number;   // geom mean of sourceBrier × sourceClv
    // ── legacy sub-components (display only, not in weighted sum) ──
    consensus: number;       // multi-source agreement (0-1)
    lowDisagreement: number; // 1 - normalized disagreement (0-1)
    marketClv: number;       // sigmoid(CLV) — positive CLV → >0.5
    sourceBrier: number;     // 1 - brier/0.25 (better sources → higher)
    sourceClv: number;       // sigmoid(avg source CLV)
    tierHistory: number;     // observed tier win rate (or 0.5 cold start)
    h2h: number;             // past head-to-head agreement (0-1, or 0.5 if no data)
  };
  /** Sample count backing the tierHistory component (0 = cold start). */
  sampleCount: number;
  /** Past H2H agreement breakdown (null when no H2H data available). */
  h2hBreakdown: H2HAgreementResult | null;
}

export interface ParlayTierStatsRow {
  tier: string;
  totalParlays: number;
  wonParlays: number;
  totalLegs: number;
  wonLegs: number;
  rollingWinRate: number;
  lifetimeWinRate: number;
  sampleCount: number; // = totalParlays
}

// ──────────────────────────────────────────────────────────────────────────────
// Weights — DE-CORRELATED v2
// ──────────────────────────────────────────────────────────────────────────────
// 6 effective signals (down from 8). The two correlated pairs have been
// collapsed into single aggregates, freeing weight budget that we redirect
// into H2H (the dominant safety signal the user explicitly asked for).
//
// Verified sum: 0.25 + 0.13 + 0.10 + 0.10 + 0.05 + 0.37 = 1.00
//
// H2H is now 0.37 — over a third of the entire reliability score. A 0.80 prob
// pick that H2H actively contradicts will see its reliability drop by up to
// 0.37 × (1 - 0) = 0.37 points vs a fully-endorsed pick. Combined with the
// hard per-tier H2H filter in buildGreedyParlayML, this means a contradicting
// H2H is BOTH a scoring penalty AND a hard exclusion from safest/medium tiers.
//
// These weights are STARTING VALUES. Use `scripts/backtest-weights.ts` to
// grid-search against historical settled matches and re-calibrate.
export const ML_WEIGHTS = {
  prob: 0.25,            // Calibrated probability — 2nd-largest signal
  sourceCohesion: 0.13,  // Collapsed consensus × lowDisagreement
  marketClv: 0.10,       // This combo historically beats the closing line
  sourceQuality: 0.10,   // Collapsed sourceBrier × sourceClv
  tierHistory: 0.05,     // Win rate of similar parlays historically
  h2h: 0.37,             // Past H2H agreement — DOMINANT safety signal
} as const;

// ──────────────────────────────────────────────────────────────────────────────
// Per-leg ML scoring
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute the ML reliability score for a single candidate leg.
 *
 * Pure function — given the leg's input signals + the tier's historical win
 * rate, returns the reliability score + per-component breakdown.
 *
 * The score is a weighted linear combination of normalized components, each
 * in [0, 1]. Weights sum to 1.0 (see ML_WEIGHTS).
 *
 * The two correlated sub-component pairs are combined via geometric mean
 * BEFORE the weighted sum, which:
 *   - Removes double-counting of the same underlying signal.
 *   - Requires BOTH sub-signals to be strong (a leg with 4 sources but high
 *     disagreement scores low on `sourceCohesion`, not high).
 *   - Is symmetric and bounded in [0, 1] like its inputs.
 */
export function computeLegMLScore(
  leg: LegInput,
  tierHistoryWinRate: number,
  tierSampleCount: number
): LegMLScore {
  // ── Component 1: Platt-calibrated probability ──────────────────────────
  // Weighted average of per-source Platt-calibrated probabilities, then
  // re-normalized to [0, 1].
  let weightedProb = 0;
  let weightSum = 0;
  for (const s of leg.sources) {
    const calibrated = applyPlatt(s.rawProb, s.calibrationA, s.calibrationB);
    weightedProb += s.weight * calibrated;
    weightSum += s.weight;
  }
  const calibratedProb = weightSum > 0
    ? Math.max(0.001, Math.min(0.999, weightedProb / weightSum))
    : leg.probability; // fallback to engine probability if no source info

  // ── Sub-component 2a: Multi-source consensus ───────────────────────────
  // Normalized: 1 source = 0.0, 2 sources = 0.33, 3 sources = 0.67, 4+ = 1.0
  // (Saturates at 4 sources — beyond that, more sources don't add much.)
  const consensus = Math.min(1, Math.max(0, (leg.consensusSources - 1) / 3));

  // ── Sub-component 2b: Low disagreement ─────────────────────────────────
  // disagreement is the stdev of per-source probabilities. 0 = perfect
  // agreement, ~0.3 = high disagreement. Normalize: 1 - min(disagreement/0.3, 1)
  const disagreementNorm = leg.disagreement !== null && leg.disagreement !== undefined
    ? Math.min(1, Math.max(0, 1 - leg.disagreement / 0.3))
    : 0.5; // unknown disagreement → neutral

  // ── Component 2 (v2): Source cohesion = sqrt(consensus × lowDisagreement) ──
  // Geometric mean so a leg needs BOTH many sources AND low disagreement.
  // A single-source leg (consensus=0) gets 0 even if disagreement is 0.
  // A 4-source leg with stdev 0.3 (lowDisagreement=0) also gets 0.
  // This de-correlates the two previously-overlapping signals.
  //
  // Cold start when disagreement is unknown: we still have consensus, so we
  // use sqrt(consensus × 0.5) — giving the leg partial credit for source count
  // without double-counting the unknown disagreement.
  const cohesionLowDisagForAgg = (leg.disagreement === null || leg.disagreement === undefined)
    ? 0.5
    : disagreementNorm;
  const sourceCohesion = Math.sqrt(consensus * cohesionLowDisagForAgg);

  // ── Component 3: Market-league CLV ────────────────────────────────────
  // CLV > 0 = we beat the closing line (good). Sigmoid so +5% CLV → ~0.99,
  // 0% CLV → 0.5, -5% CLV → ~0.01.
  const marketClv = leg.marketLeagueClv !== null
    ? sigmoid((leg.marketLeagueClv ?? 0) * 6) // ×6 so ±5% CLV saturates
    : 0.5; // no history → neutral

  // ── Sub-component 4a: Source Brier (recent calibration quality) ─────────
  // Weighted average of (1 - brier/0.25) across sources. Brier 0 = perfect,
  // 0.25 = random. So (1 - brier/0.25) maps [0, 0.25] → [1, 0].
  let brierSum = 0;
  let brierWeight = 0;
  for (const s of leg.sources) {
    const score = Math.max(0, Math.min(1, 1 - s.brier30d / 0.25));
    brierSum += s.weight * score;
    brierWeight += s.weight;
  }
  const sourceBrier = brierWeight > 0 ? brierSum / brierWeight : 0.5;

  // ── Sub-component 4b: Source CLV (recent CLV performance) ──────────────
  let clvSum = 0;
  let clvWeight = 0;
  for (const s of leg.sources) {
    const score = sigmoid(s.clv30d * 6);
    clvSum += s.weight * score;
    clvWeight += s.weight;
  }
  const sourceClv = clvWeight > 0 ? clvSum / clvWeight : 0.5;

  // ── Component 4 (v2): Source quality = sqrt(sourceBrier × sourceClv) ────
  // Geometric mean so a source must be BOTH well-calibrated AND sharp (beat
  // the close) to score high. A perfectly-calibrated source that never beats
  // the close is theoretical-only; a CLV winner with poor calibration is
  // noisy. Both halves matter.
  const sourceQuality = Math.sqrt(sourceBrier * sourceClv);

  // ── Component 5: Tier historical win rate ──────────────────────────────
  // Cold-start (sampleCount = 0): use 0.5 (neutral). As samples accumulate,
  // the actual win rate takes over.
  const tierHistory = tierSampleCount > 0
    ? Math.max(0, Math.min(1, tierHistoryWinRate))
    : 0.5;

  // ── Component 6: Past H2H agreement ────────────────────────────────────
  // Market-aware agreement between the prediction's selection and the
  // historical head-to-head record. Returns null if no H2H data — we then
  // fall back to 0.5 (neutral) so legs without H2H data aren't penalized.
  const h2hBreakdown = computeH2HAgreement(leg.h2hJson, leg.market, leg.selection);
  const h2h = h2hBreakdown ? h2hBreakdown.score : 0.5;

  // ── Weighted combination (uses v2 aggregated components) ───────────────
  const components: LegMLScore["components"] = {
    prob: calibratedProb,
    // v2 aggregates — used in the weighted sum
    sourceCohesion,
    sourceQuality,
    // legacy sub-components — kept for UI display only
    consensus,
    lowDisagreement: disagreementNorm,
    marketClv,
    sourceBrier,
    sourceClv,
    tierHistory,
    h2h,
  };

  const reliability = Math.max(0, Math.min(1,
    ML_WEIGHTS.prob * components.prob +
    ML_WEIGHTS.sourceCohesion * components.sourceCohesion +
    ML_WEIGHTS.marketClv * components.marketClv +
    ML_WEIGHTS.sourceQuality * components.sourceQuality +
    ML_WEIGHTS.tierHistory * components.tierHistory +
    ML_WEIGHTS.h2h * components.h2h
  ));

  // ── ML-adjusted probability ─────────────────────────────────────────────
  // For parlay math: blend raw calibrated probability with the reliability
  // score. A 0.80 prob with 0.95 reliability stays at ~0.80; a 0.80 prob with
  // 0.50 reliability drops to ~0.65 (we're less confident in that 0.80).
  // This way the parlay's combined probability reflects BOTH the stated
  // probability AND how much we trust that probability — including the H2H
  // signal that's now baked into `reliability`.
  const adjustedProb = Math.max(0.001, Math.min(0.999,
    calibratedProb * 0.7 + reliability * 0.3
  ));

  return {
    reliability,
    calibratedProb,
    adjustedProb,
    components,
    sampleCount: tierSampleCount,
    h2hBreakdown,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Bayesian shrinkage — blend theoretical probability with observed win rate
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Bayesian-adjusted combined probability for a parlay tier.
 *
 * - `prior` = theoretical combined probability (raw Π p_i with correlation
 *   haircut, computed by the parlay builder).
 * - `observedWinRate` = historical win rate for this tier.
 * - `observedCount` = number of settled parlays backing the observed rate.
 * - `priorStrength` = pseudo-count for the prior (default 10 = "trust the
 *   math as much as 10 observed parlays"). Higher = slower to adapt.
 *
 * Returns the posterior mean: a weighted blend that starts at `prior` when
 * observedCount=0 and converges to `observedWinRate` as observedCount → ∞.
 *
 * Cold-start: 0 samples → returns prior unchanged.
 * Mature:     30 samples → ~75% weight on observed, ~25% on prior.
 * Saturated:  100+ samples → ~91% weight on observed.
 */
export function bayesianCombinedProb(
  prior: number,
  observedWinRate: number,
  observedCount: number,
  priorStrength: number = 10
): number {
  if (observedCount <= 0) return prior;
  const total = priorStrength + observedCount;
  const posterior = (prior * priorStrength + observedWinRate * observedCount) / total;
  return Math.max(0.001, Math.min(0.999, posterior));
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-tier stats DB helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Load (or initialize) the rolling stats for a parlay tier. */
export async function loadParlayTierStats(tier: string): Promise<ParlayTierStatsRow> {
  const row = await db.parlayTierStats.findUnique({ where: { tier } });
  if (!row) {
    return {
      tier,
      totalParlays: 0,
      wonParlays: 0,
      totalLegs: 0,
      wonLegs: 0,
      rollingWinRate: 0,
      lifetimeWinRate: 0,
      sampleCount: 0,
    };
  }
  return {
    tier: row.tier,
    totalParlays: row.totalParlays,
    wonParlays: row.wonParlays,
    totalLegs: row.totalLegs,
    wonLegs: row.wonLegs,
    rollingWinRate: row.rollingWinRate,
    lifetimeWinRate: row.lifetimeWinRate,
    sampleCount: row.totalParlays,
  };
}

/** Load stats for all tiers in one batched call. */
export async function loadAllParlayTierStats(): Promise<Map<string, ParlayTierStatsRow>> {
  const rows = await db.parlayTierStats.findMany();
  const map = new Map<string, ParlayTierStatsRow>();
  for (const row of rows) {
    map.set(row.tier, {
      tier: row.tier,
      totalParlays: row.totalParlays,
      wonParlays: row.wonParlays,
      totalLegs: row.totalLegs,
      wonLegs: row.wonLegs,
      rollingWinRate: row.rollingWinRate,
      lifetimeWinRate: row.lifetimeWinRate,
      sampleCount: row.totalParlays,
    });
  }
  return map;
}

/**
 * Update tier stats after a parlay settles. Called by the feedback loop.
 *
 * - Increments totalParlays / wonParlays / totalLegs / wonLegs.
 * - Updates the rolling 30-parlay EMA win rate.
 * - Pushes a new entry into the rolling results window (capped at 50).
 */
export async function updateParlayTierStats(
  tier: string,
  won: boolean,
  legsCount: number,
  legsWon: number,
  combinedProb: number,
  dateStr: string
): Promise<void> {
  const existing = await db.parlayTierStats.findUnique({ where: { tier } });

  // Parse existing recent results
  let recent: Array<{ date: string; won: boolean; legsCount: number; legsWon: number; combinedProb: number }> = [];
  if (existing?.recentResultsJson) {
    try {
      recent = JSON.parse(existing.recentResultsJson) as typeof recent;
    } catch {
      recent = [];
    }
  }

  // Push new entry and cap at 50
  recent.push({ date: dateStr, won, legsCount, legsWon, combinedProb });
  if (recent.length > 50) recent = recent.slice(-50);

  // Compute new lifetime stats
  const totalParlays = (existing?.totalParlays ?? 0) + 1;
  const wonParlays = (existing?.wonParlays ?? 0) + (won ? 1 : 0);
  const totalLegs = (existing?.totalLegs ?? 0) + legsCount;
  const wonLegs = (existing?.wonLegs ?? 0) + legsWon;
  const lifetimeWinRate = totalParlays > 0 ? wonParlays / totalParlays : 0;

  // Rolling EMA win rate over the last 30 parlays (more recent = more weight)
  // α = 2/(N+1) for N=30 → α ≈ 0.0645
  const recentWindow = recent.slice(-30);
  let ema = existing?.rollingWinRate ?? 0.5;
  const alpha = 2 / (recentWindow.length + 1);
  for (const r of recentWindow) {
    ema = (1 - alpha) * ema + alpha * (r.won ? 1 : 0);
  }
  // If we have fewer than 5 samples, the EMA is unreliable — fall back to lifetime.
  const rollingWinRate = totalParlays >= 5 ? ema : lifetimeWinRate;

  await db.parlayTierStats.upsert({
    where: { tier },
    create: {
      tier,
      totalParlays,
      wonParlays,
      totalLegs,
      wonLegs,
      rollingWinRate,
      lifetimeWinRate,
      recentResultsJson: JSON.stringify(recent),
    },
    update: {
      totalParlays,
      wonParlays,
      totalLegs,
      wonLegs,
      rollingWinRate,
      lifetimeWinRate,
      recentResultsJson: JSON.stringify(recent),
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Safety grade — for UI display
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convert an ML reliability score (0-1) into a letter grade for UI display.
 *
 * A+ : ≥ 0.85 (exceptional — multi-source consensus, strong CLV, low disagreement)
 * A  : 0.75–0.85 (strong — investment-grade)
 * B  : 0.60–0.75 (good — acceptable for medium-risk tiers)
 * C  : 0.45–0.60 (speculative — only for high-risk / mega-odds tiers)
 * D  : < 0.45 (weak — should not appear in any "safe" tier)
 */
export function mlScoreToGrade(score: number): { grade: string; color: string; label: string } {
  if (score >= 0.85) return { grade: "A+", color: "emerald", label: "Elite" };
  if (score >= 0.75) return { grade: "A", color: "emerald", label: "Strong" };
  if (score >= 0.60) return { grade: "B", color: "lime", label: "Good" };
  if (score >= 0.45) return { grade: "C", color: "amber", label: "Speculative" };
  return { grade: "D", color: "rose", label: "Weak" };
}

// ──────────────────────────────────────────────────────────────────────────────
// Source lookup helper — preloads all sources into a map for fast scoring
// ──────────────────────────────────────────────────────────────────────────────

export interface SourceMLInfo {
  sourceId: string;
  name: string;
  weight: number;
  brier30d: number;
  clv30d: number;
  calibrationA: number;
  calibrationB: number;
}

/** Load all sources into a Map for O(1) lookup during parlay building. */
export async function loadSourceMLInfo(): Promise<Map<string, SourceMLInfo>> {
  const sources = await db.source.findMany();
  const map = new Map<string, SourceMLInfo>();
  for (const s of sources) {
    map.set(s.name, {
      sourceId: s.id,
      name: s.name,
      weight: s.weight,
      brier30d: s.brier30d,
      clv30d: s.clv30d,
      calibrationA: s.calibrationA,
      calibrationB: s.calibrationB,
    });
  }
  return map;
}

// ──────────────────────────────────────────────────────────────────────────────
// Weight backtest harness — used by scripts/backtest-weights.ts
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Custom-weight variant of `computeLegMLScore` used by the weight backtester.
 *
 * Same logic as `computeLegMLScore` but accepts an alternative weight vector
 * so the backtester can grid-search different combinations without mutating
 * the production `ML_WEIGHTS` constant. The returned shape is the same as
 * `LegMLScore` (with `sampleCount` and `h2hBreakdown` set to neutral defaults
 * since the backtester typically runs in cold-start mode without per-tier
 * historical data).
 */
export function computeLegMLScoreWithWeights(
  leg: LegInput,
  weights: {
    prob: number;
    sourceCohesion: number;
    marketClv: number;
    sourceQuality: number;
    tierHistory: number;
    h2h: number;
  },
  tierHistoryWinRate: number = 0.5,
  tierSampleCount: number = 0
): LegMLScore {
  // Reuse the canonical computation by temporarily swapping the weights.
  // We can't reassign ML_WEIGHTS (it's `as const`), so we inline the math.
  let weightedProb = 0;
  let weightSum = 0;
  for (const s of leg.sources) {
    const calibrated = applyPlatt(s.rawProb, s.calibrationA, s.calibrationB);
    weightedProb += s.weight * calibrated;
    weightSum += s.weight;
  }
  const calibratedProb = weightSum > 0
    ? Math.max(0.001, Math.min(0.999, weightedProb / weightSum))
    : leg.probability;

  const consensus = Math.min(1, Math.max(0, (leg.consensusSources - 1) / 3));
  const disagreementNorm = leg.disagreement !== null && leg.disagreement !== undefined
    ? Math.min(1, Math.max(0, 1 - leg.disagreement / 0.3))
    : 0.5;
  const cohesionLowDisagForAgg = (leg.disagreement === null || leg.disagreement === undefined)
    ? 0.5
    : disagreementNorm;
  const sourceCohesion = Math.sqrt(consensus * cohesionLowDisagForAgg);

  const marketClv = leg.marketLeagueClv !== null
    ? sigmoid((leg.marketLeagueClv ?? 0) * 6)
    : 0.5;

  let brierSum = 0, brierWeight = 0;
  for (const s of leg.sources) {
    const score = Math.max(0, Math.min(1, 1 - s.brier30d / 0.25));
    brierSum += s.weight * score;
    brierWeight += s.weight;
  }
  const sourceBrier = brierWeight > 0 ? brierSum / brierWeight : 0.5;

  let clvSum = 0, clvWeight = 0;
  for (const s of leg.sources) {
    const score = sigmoid(s.clv30d * 6);
    clvSum += s.weight * score;
    clvWeight += s.weight;
  }
  const sourceClv = clvWeight > 0 ? clvSum / clvWeight : 0.5;
  const sourceQuality = Math.sqrt(sourceBrier * sourceClv);

  const tierHistory = tierSampleCount > 0
    ? Math.max(0, Math.min(1, tierHistoryWinRate))
    : 0.5;

  const h2hBreakdown = computeH2HAgreement(leg.h2hJson, leg.market, leg.selection);
  const h2h = h2hBreakdown ? h2hBreakdown.score : 0.5;

  const components: LegMLScore["components"] = {
    prob: calibratedProb,
    sourceCohesion,
    sourceQuality,
    consensus,
    lowDisagreement: disagreementNorm,
    marketClv,
    sourceBrier,
    sourceClv,
    tierHistory,
    h2h,
  };

  const reliability = Math.max(0, Math.min(1,
    weights.prob * components.prob +
    weights.sourceCohesion * components.sourceCohesion +
    weights.marketClv * components.marketClv +
    weights.sourceQuality * components.sourceQuality +
    weights.tierHistory * components.tierHistory +
    weights.h2h * components.h2h
  ));

  const adjustedProb = Math.max(0.001, Math.min(0.999,
    calibratedProb * 0.7 + reliability * 0.3
  ));

  return {
    reliability,
    calibratedProb,
    adjustedProb,
    components,
    sampleCount: tierSampleCount,
    h2hBreakdown,
  };
}

/**
 * Validate that a candidate weight vector sums to 1.0 (within tolerance).
 * Used by the backtester to skip invalid grid points.
 */
export function isValidWeightVector(
  w: { prob: number; sourceCohesion: number; marketClv: number; sourceQuality: number; tierHistory: number; h2h: number },
  tolerance: number = 0.001
): boolean {
  const sum = w.prob + w.sourceCohesion + w.marketClv + w.sourceQuality + w.tierHistory + w.h2h;
  return Math.abs(sum - 1.0) <= tolerance;
}
