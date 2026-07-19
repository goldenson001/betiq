/**
 * Portfolio Risk Management
 * ─────────────────────────
 * Three layers of capital preservation:
 *
 *   1. Portfolio daily Kelly cap (B1) — sum of all recommended stakes on a
 *      single day cannot exceed DAILY_MAX_EXPOSURE (default 15% of bankroll).
 *      When exceeded, every stake is scaled down pro-rata.
 *
 *   2. Drawdown circuit breaker (B2) — when the model hits a losing streak
 *      or drawdown threshold, automatically halve stakes (degraded) or zero
 *      them entirely (halted). Recovery after N consecutive winning days.
 *
 *   3. Correlation-aware parlay Kelly (B4) — parlay legs aren't actually
 *      independent (same-league same-day legs share referee/weather; same
 *      kickoff cluster shares pitch conditions). Apply a haircut to combined
 *      probability before computing Kelly.
 *
 * All three are PURE FUNCTIONS — they take the current state and return
 * adjusted values. No DB access, no side effects, easily unit-testable.
 */

import { ENGINE_CONFIG } from "@/lib/config";

// ──────────────────────────────────────────────────────────────────────────────
// B1: Portfolio daily Kelly cap
// ──────────────────────────────────────────────────────────────────────────────

export interface StakeAdjustment {
  /** Final stake as fraction of bankroll (already capped). */
  recommendedStake: number;
  /** Original stake before portfolio cap. */
  originalStake: number;
  /** Scale factor applied (1.0 = no scaling, <1.0 = portfolio cap engaged). */
  scaleFactor: number;
}

/**
 * Apply portfolio-level cap to a set of recommended stakes.
 *
 * If the sum of stakes exceeds DAILY_MAX_EXPOSURE, scale every stake pro-rata
 * so the sum equals the cap. Returns the adjusted stakes + the scale factor
 * (for UI display: "Today's picks are running at 60% Kelly").
 *
 * If the sum is already under the cap, returns stakes unchanged (scale = 1.0).
 *
 * NOTE: This is a SOFT cap. Hard caps per individual pick (5% singles, 2%
 * parlays) are still applied by kelly.ts. The portfolio cap kicks in when
 * MANY picks fire on the same day.
 */
export function applyPortfolioCap(
  stakes: Array<{ recommendedStake: number }>,
  maxExposure: number = ENGINE_CONFIG.DAILY_MAX_EXPOSURE
): { adjustments: StakeAdjustment[]; scaleFactor: number; totalExposure: number } {
  const total = stakes.reduce((s, x) => s + Math.max(0, x.recommendedStake), 0);
  if (total <= maxExposure || total <= 0 || maxExposure >= 1.0) {
    return {
      adjustments: stakes.map((s) => ({
        recommendedStake: s.recommendedStake,
        originalStake: s.recommendedStake,
        scaleFactor: 1.0,
      })),
      scaleFactor: 1.0,
      totalExposure: total,
    };
  }
  const scale = maxExposure / total;
  return {
    adjustments: stakes.map((s) => ({
      recommendedStake: s.recommendedStake * scale,
      originalStake: s.recommendedStake,
      scaleFactor: scale,
    })),
    scaleFactor: scale,
    totalExposure: maxExposure,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// B2: Drawdown circuit breaker
// ──────────────────────────────────────────────────────────────────────────────

export type DrawdownState = "normal" | "degraded" | "halted";

export interface DrawdownContext {
  /** Current loseStreak (consecutive losing days, winRate < 0.5). */
  loseStreak: number;
  /** Current winStreak (consecutive winning days). */
  winStreak: number;
  /** Peak rolling-7-day kellyRoi over the trailing window. */
  peakRoi: number;
  /** Current rolling-7-day kellyRoi. */
  currentRoi: number;
  /** Previous state — needed for recovery logic. */
  previousState: DrawdownState;
}

export interface DrawdownDecision {
  state: DrawdownState;
  /** Stake multiplier to apply to all recommendations:
   *    normal   → 1.0
   *    degraded → DRAWDOWN_DEGRADED_FACTOR (default 0.5)
   *    halted   → 0.0
   */
  stakeMultiplier: number;
  /** Human-readable reason for the state — surfaced in UI banner. */
  reason: string;
}

/**
 * Compute the new drawdown state given recent performance.
 *
 * Transition rules:
 *   normal → degraded:  loseStreak ≥ DRAWDOWN_DEGRADED_STREAK
 *                       OR drawdown ≥ DRAWDOWN_DEGRADED_PCT
 *   normal → halted:    drawdown ≥ DRAWDOWN_HALT_PCT
 *   degraded → halted:  drawdown ≥ DRAWDOWN_HALT_PCT
 *   degraded → normal:  winStreak ≥ DRAWDOWN_RECOVERY_WIN_DAYS
 *   halted → normal:    winStreak ≥ DRAWDOWN_RECOVERY_WIN_DAYS (manual resume
 *                       recommended but auto-resume allowed for safety)
 *
 * Drawdown is measured as the fractional drop from peak cumulative ROI to
 * current cumulative ROI. CAPPED AT 1.0 (100%) — you cannot lose more than
 * your entire bankroll, so reported drawdowns > 100% are mathematically
 * nonsensical and indicate a computation bug elsewhere (e.g. dividing by a
 * near-zero peakRoi).
 *
 * Old (buggy) formula: (peakRoi - currentRoi) / max(peakRoi, 0.001)
 *   — when peakRoi was tiny (e.g. 0.005 = 0.5%) and currentRoi was
 *     strongly negative (e.g. -0.07 = -7%), this returned 13.0 = 1300%,
 *     producing the impossible "Drawdown at 1493.3%" UI banner.
 *
 * New formula: max(0, peakRoi - currentRoi), capped at 1.0.
 *   — Treats ROI drop as absolute bankroll fraction. A 5% peak → -7% current
 *     = 12% drop, which is 0.12 (12%), not 1300%. Mathematically sound.
 */
export function computeDrawdownState(ctx: DrawdownContext): DrawdownDecision {
  const {
    loseStreak,
    winStreak,
    peakRoi,
    currentRoi,
    previousState,
  } = ctx;

  // ── Drawdown = peak-to-current drop, capped at 100% ──────────────────────
  // A peak ROI of +5% followed by current ROI of -7% means the bankroll has
  // dropped 12% from its peak. That's a 0.12 drawdown. The old formula
  // divided by peakRoi (a tiny number) producing absurd 1000%+ values.
  const drawdown = Math.min(1.0, Math.max(0, peakRoi - currentRoi));

  // ── Recovery check (applies to degraded AND halted) ──────────────────────
  if (previousState !== "normal") {
    const recoveryDays = ENGINE_CONFIG.DRAWDOWN_RECOVERY_WIN_DAYS;
    if (winStreak >= recoveryDays && drawdown < ENGINE_CONFIG.DRAWDOWN_DEGRADED_PCT) {
      return {
        state: "normal",
        stakeMultiplier: 1.0,
        reason: `Recovered after ${winStreak} consecutive winning days. Stakes restored to full Kelly.`,
      };
    }
  }

  // ── Halt check (highest priority) ────────────────────────────────────────
  if (drawdown >= ENGINE_CONFIG.DRAWDOWN_HALT_PCT) {
    return {
      state: "halted",
      stakeMultiplier: 0.0,
      reason: `Drawdown at ${(drawdown * 100).toFixed(1)}% (≥ ${(ENGINE_CONFIG.DRAWDOWN_HALT_PCT * 100).toFixed(0)}% halt threshold). Stakes zeroed — review model before resuming.`,
    };
  }

  // ── Degrade check ────────────────────────────────────────────────────────
  if (
    loseStreak >= ENGINE_CONFIG.DRAWDOWN_DEGRADED_STREAK ||
    drawdown >= ENGINE_CONFIG.DRAWDOWN_DEGRADED_PCT
  ) {
    return {
      state: "degraded",
      stakeMultiplier: ENGINE_CONFIG.DRAWDOWN_DEGRADED_FACTOR,
      reason:
        loseStreak >= ENGINE_CONFIG.DRAWDOWN_DEGRADED_STREAK
          ? `${loseStreak}-day losing streak (≥ ${ENGINE_CONFIG.DRAWDOWN_DEGRADED_STREAK} threshold). Stakes reduced to ${(ENGINE_CONFIG.DRAWDOWN_DEGRADED_FACTOR * 100).toFixed(0)}% of Kelly.`
          : `Drawdown at ${(drawdown * 100).toFixed(1)}% (≥ ${(ENGINE_CONFIG.DRAWDOWN_DEGRADED_PCT * 100).toFixed(0)}% threshold). Stakes reduced to ${(ENGINE_CONFIG.DRAWDOWN_DEGRADED_FACTOR * 100).toFixed(0)}% of Kelly.`,
    };
  }

  // ── Stay normal ──────────────────────────────────────────────────────────
  return {
    state: "normal",
    stakeMultiplier: 1.0,
    reason: previousState !== "normal"
      ? `Recovered to normal. Stakes at full Kelly.`
      : "Stakes at full Kelly.",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// B4: Correlation-aware parlay Kelly
// ──────────────────────────────────────────────────────────────────────────────

export interface ParlayLegMeta {
  leagueId?: string | null;
  kickoffUtc?: Date | string | null;
}

/**
 * Compute a haircut to apply to a parlay's combined probability to account
 * for correlation between legs. The default independence assumption
 * (combined = Π p_i) OVER-estimates win probability when legs are correlated.
 *
 * Two correlation factors:
 *   1. Same-league same-date legs share referee pool, weather, pitch
 *      conditions → PARLAY_SAME_LEAGUE_HAIRCUT per pair of correlated legs.
 *   2. 3+ legs within a PARLAY_TIME_CLUSTER_HOURS window share pitch-weather
 *      correlation → PARLAY_TIME_CLUSTER_HAIRCUT.
 *
 * Returns a multiplier in [0, 1] — multiply combined probability by this.
 */
export function correlationHaircut(legs: ParlayLegMeta[]): number {
  if (legs.length < 2) return 1.0;

  // ── Same-league pairs ──────────────────────────────────────────────────
  let sameLeaguePairs = 0;
  const byLeague = new Map<string, number>();
  for (const leg of legs) {
    if (!leg.leagueId) continue;
    byLeague.set(leg.leagueId, (byLeague.get(leg.leagueId) ?? 0) + 1);
  }
  for (const count of byLeague.values()) {
    if (count >= 2) {
      // Number of pairs = C(count, 2)
      sameLeaguePairs += (count * (count - 1)) / 2;
    }
  }

  // ── Time-clustered legs (3+ within a sliding window) ────────────────────
  const times = legs
    .map((l) => (l.kickoffUtc instanceof Date ? l.kickoffUtc.getTime() : l.kickoffUtc ? new Date(l.kickoffUtc).getTime() : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  let maxCluster = 0;
  const windowMs = ENGINE_CONFIG.PARLAY_TIME_CLUSTER_HOURS * 60 * 60 * 1000;
  for (let i = 0; i < times.length; i++) {
    let count = 1;
    for (let j = i + 1; j < times.length; j++) {
      if (times[j] - times[i] <= windowMs) count++;
      else break;
    }
    if (count > maxCluster) maxCluster = count;
  }

  // Total haircut — each factor subtracts from 1.0, floored at 0.5 to avoid
  // collapsing a parlay entirely.
  const leagueHaircut = Math.min(0.30, sameLeaguePairs * ENGINE_CONFIG.PARLAY_SAME_LEAGUE_HAIRCUT);
  const timeHaircut = maxCluster >= 3 ? ENGINE_CONFIG.PARLAY_TIME_CLUSTER_HAIRCUT : 0;
  const totalHaircut = Math.min(0.50, leagueHaircut + timeHaircut);

  return Math.max(0.50, 1.0 - totalHaircut);
}

/**
 * Convenience: apply correlation haircut to combined probability.
 * Returns the adjusted (lower) combined probability.
 */
export function applyCorrelationHaircut(
  combinedProbability: number,
  legs: ParlayLegMeta[]
): { adjustedProbability: number; haircutMultiplier: number } {
  const mult = correlationHaircut(legs);
  return {
    adjustedProbability: combinedProbability * mult,
    haircutMultiplier: mult,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Combined risk gate — applied after Kelly but before persistence
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Apply BOTH drawdown multiplier AND portfolio cap to a set of (stake, isBet)
 * pairs. The drawdown multiplier is applied first (per-stake), then the
 * portfolio cap (across all stakes).
 *
 * Returns the final recommended stakes + diagnostics for the UI.
 */
export function applyRiskGates(
  stakes: Array<{ recommendedStake: number; isBet: boolean }>,
  drawdownMultiplier: number
): {
  finalStakes: number[];
  portfolioScale: number;
  totalExposure: number;
} {
  // Step 1: Apply drawdown multiplier to each stake
  const afterDrawdown = stakes.map((s) => ({
    recommendedStake: Math.max(0, s.recommendedStake * drawdownMultiplier),
    isBet: s.isBet,
  }));

  // Step 2: Apply portfolio cap across all "bet" stakes (top picks + value
  // bets + safe-high-odds). Non-bet predictions (recommendedStake = 0) don't
  // participate in the cap.
  const betStakes = afterDrawdown.filter((s) => s.isBet && s.recommendedStake > 0);
  const portfolioResult = applyPortfolioCap(betStakes);

  // Step 3: Reassemble final stakes in original order
  let portfolioIdx = 0;
  const finalStakes = afterDrawdown.map((s) => {
    if (!s.isBet || s.recommendedStake <= 0) return 0;
    const adj = portfolioResult.adjustments[portfolioIdx++];
    return adj.recommendedStake;
  });

  return {
    finalStakes,
    portfolioScale: portfolioResult.scaleFactor,
    totalExposure: portfolioResult.totalExposure,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// B5: Daily-loss circuit breaker (REAL-MONEY SAFETY)
// ──────────────────────────────────────────────────────────────────────────────

export type DailyLossState = "normal" | "degraded" | "halted";

export interface DailyLossContext {
  /** Fraction of bankroll lost TODAY from already-settled parlays.
   *  Positive number = net loss. Negative = net profit (good day).
   *  Example: 0.04 = lost 4% of bankroll today. */
  todayLossFraction: number;
  /** Fraction of bankroll currently at-risk in unsettled parlays today.
   *  Used for diagnostics only — does not affect the decision. */
  atRiskFraction: number;
}

export interface DailyLossDecision {
  state: DailyLossState;
  /** Stake multiplier to apply to all remaining recommendations TODAY:
   *    normal   → 1.0
   *    degraded → DAILY_LOSS_DEGRADED_FACTOR (default 0.3)
   *    halted   → 0.0
   */
  stakeMultiplier: number;
  /** Human-readable reason — surfaced in UI banner. */
  reason: string;
}

/**
 * Compute the daily-loss circuit breaker state.
 *
 * This is SEPARATE from the rolling drawdown breaker (B2) — it reacts to a
 * single catastrophic day, not a sustained bad regime. Both can be active
 * simultaneously; the EFFECTIVE multiplier is the MIN of the two (most
 * conservative wins).
 *
 * Transition rules:
 *   normal → degraded:  todayLossFraction ≥ MAX_DAILY_LOSS_DEGRADE_PCT
 *   normal → halted:    todayLossFraction ≥ MAX_DAILY_LOSS_HALT_PCT
 *   degraded → halted:  todayLossFraction ≥ MAX_DAILY_LOSS_HALT_PCT
 *
 * No automatic recovery within the same day — once halted, stays halted
 * until the next pipeline run (next calendar day). This is intentional:
 * if today is bad enough to halt, we don't try to "make it back" with
 * later parlays.
 *
 * The decision is RESET to "normal" at the start of each new pipeline run
 * (when the daily loss counter is zeroed).
 */
export function computeDailyLossState(ctx: DailyLossContext): DailyLossDecision {
  const { todayLossFraction, atRiskFraction } = ctx;
  void atRiskFraction; // diagnostic only

  // Halt check (highest priority)
  if (todayLossFraction >= ENGINE_CONFIG.MAX_DAILY_LOSS_HALT_PCT) {
    return {
      state: "halted",
      stakeMultiplier: 0.0,
      reason: `Daily loss at ${(todayLossFraction * 100).toFixed(1)}% of bankroll ` +
              `(≥ ${(ENGINE_CONFIG.MAX_DAILY_LOSS_HALT_PCT * 100).toFixed(0)}% halt threshold). ` +
              `All remaining stakes ZEROED for today. Resume next pipeline run.`,
    };
  }

  // Degrade check
  if (todayLossFraction >= ENGINE_CONFIG.MAX_DAILY_LOSS_DEGRADE_PCT) {
    return {
      state: "degraded",
      stakeMultiplier: ENGINE_CONFIG.DAILY_LOSS_DEGRADED_FACTOR,
      reason: `Daily loss at ${(todayLossFraction * 100).toFixed(1)}% of bankroll ` +
              `(≥ ${(ENGINE_CONFIG.MAX_DAILY_LOSS_DEGRADE_PCT * 100).toFixed(0)}% threshold). ` +
              `Remaining stakes reduced to ${(ENGINE_CONFIG.DAILY_LOSS_DEGRADED_FACTOR * 100).toFixed(0)}% of Kelly.`,
    };
  }

  return {
    state: "normal",
    stakeMultiplier: 1.0,
    reason: "Daily loss within tolerance. Stakes at full Kelly.",
  };
}

/**
 * Combine the drawdown breaker (B2) and the daily-loss breaker (B5) into a
 * single effective stake multiplier. The most conservative state wins.
 *
 *   If EITHER breaker says "halted" → halted (multiplier 0.0)
 *   Else if EITHER says "degraded"  → degraded (use the LOWER multiplier)
 *   Else                            → normal (multiplier 1.0)
 */
export function combineRiskStates(
  drawdown: DrawdownDecision,
  dailyLoss: DailyLossDecision
): {
  state: "normal" | "degraded" | "halted";
  stakeMultiplier: number;
  reason: string;
} {
  if (drawdown.state === "halted" || dailyLoss.state === "halted") {
    return {
      state: "halted",
      stakeMultiplier: 0.0,
      reason: drawdown.state === "halted" ? drawdown.reason : dailyLoss.reason,
    };
  }
  if (drawdown.state === "degraded" || dailyLoss.state === "degraded") {
    return {
      state: "degraded",
      stakeMultiplier: Math.min(drawdown.stakeMultiplier, dailyLoss.stakeMultiplier),
      reason: drawdown.state === "degraded" ? drawdown.reason : dailyLoss.reason,
    };
  }
  return {
    state: "normal",
    stakeMultiplier: 1.0,
    reason: "All risk gates normal. Stakes at full Kelly.",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// B6: Data-quality gate (REAL-MONEY SAFETY)
// ──────────────────────────────────────────────────────────────────────────────

export interface DataQualityContext {
  /** Fraction of enabled scrapers that succeeded in the last 24h.
   *  Example: 0.85 = 85% of scrapers returned fresh data. */
  scraperSuccessRate: number;
  /** Fraction of today's matches that have at least 1 prediction.
   *  Example: 0.75 = 75% of matches have any source covering them. */
  matchCoverage: number;
  /** Age of the most recent successful scrape, in hours. */
  latestScrapeAgeHours: number;
}

export interface DataQualityDecision {
  /** true = data is fresh enough to trust stakes.
   *  false = zero all stakes (parlays still built for visibility). */
  pass: boolean;
  /** 0.0 (block) or 1.0 (allow). No partial trust — data quality is binary. */
  stakeMultiplier: number;
  /** Human-readable reason — surfaced in UI banner when blocking. */
  reason: string;
  /** Per-check breakdown for diagnostics. */
  checks: {
    scraperSuccess: { pass: boolean; value: number; threshold: number };
    matchCoverage: { pass: boolean; value: number; threshold: number };
    dataFreshness: { pass: boolean; value: number; threshold: number };
  };
}

/**
 * Evaluate whether today's data is fresh and complete enough to recommend
 * real-money stakes.
 *
 * If ANY check fails, returns pass=false and stakeMultiplier=0. Parlays are
 * still BUILT (so the user can see what the model would have picked) but
 * NO stakes are recommended — protecting against betting on stale or
 * partial data.
 *
 * The three checks are:
 *   1. Scraper success rate ≥ MIN_SCRAPER_SUCCESS_RATE
 *   2. Match coverage ≥ MIN_MATCH_COVERAGE
 *   3. Most recent scrape age ≤ MAX_DATA_AGE_HOURS
 */
export function evaluateDataQuality(ctx: DataQualityContext): DataQualityDecision {
  const checks = {
    scraperSuccess: {
      pass: ctx.scraperSuccessRate >= ENGINE_CONFIG.MIN_SCRAPER_SUCCESS_RATE,
      value: ctx.scraperSuccessRate,
      threshold: ENGINE_CONFIG.MIN_SCRAPER_SUCCESS_RATE,
    },
    matchCoverage: {
      pass: ctx.matchCoverage >= ENGINE_CONFIG.MIN_MATCH_COVERAGE,
      value: ctx.matchCoverage,
      threshold: ENGINE_CONFIG.MIN_MATCH_COVERAGE,
    },
    dataFreshness: {
      pass: ctx.latestScrapeAgeHours <= ENGINE_CONFIG.MAX_DATA_AGE_HOURS,
      value: ctx.latestScrapeAgeHours,
      threshold: ENGINE_CONFIG.MAX_DATA_AGE_HOURS,
    },
  };

  const allPass = checks.scraperSuccess.pass && checks.matchCoverage.pass && checks.dataFreshness.pass;

  if (allPass) {
    return {
      pass: true,
      stakeMultiplier: 1.0,
      reason: "Data quality checks passed.",
      checks,
    };
  }

  // Build a reason listing which checks failed
  const failed: string[] = [];
  if (!checks.scraperSuccess.pass) {
    failed.push(
      `scraper success ${(checks.scraperSuccess.value * 100).toFixed(0)}% ` +
      `< ${(checks.scraperSuccess.threshold * 100).toFixed(0)}%`
    );
  }
  if (!checks.matchCoverage.pass) {
    failed.push(
      `match coverage ${(checks.matchCoverage.value * 100).toFixed(0)}% ` +
      `< ${(checks.matchCoverage.threshold * 100).toFixed(0)}%`
    );
  }
  if (!checks.dataFreshness.pass) {
    failed.push(
      `latest scrape ${checks.dataFreshness.value.toFixed(1)}h old ` +
      `> ${checks.dataFreshness.threshold}h`
    );
  }

  return {
    pass: false,
    stakeMultiplier: 0.0,
    reason: `Data quality gate FAILED: ${failed.join("; ")}. Stakes zeroed — parlays still visible for review.`,
    checks,
  };
}
