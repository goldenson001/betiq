/**
 * Engine Configuration
 * ────────────────────
 * Central place for tunable thresholds used by the prediction engine,
 * calibration loop, and value-bet filter. Most can be overridden via
 * environment variables so they can be tuned without code changes.
 *
 * All values are validated/clamped at module load — bad env values fall
 * back to the documented defaults.
 */

function num(key: string, def: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}

function bool(key: string, def: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

export const ENGINE_CONFIG = {
  // ── Edge filter ────────────────────────────────────────────────────────────
  // Minimum (probability-implied) edge over book odds for a pick to be flagged
  // as a value bet. The optimal cutoff is typically 2.5-3.5% — picks below
  // this are mostly noise and have negative long-run ROI in backtests.
  //
  // Edge = bookOdds × probability - 1
  VALUE_BET_MIN_EDGE: num("VALUE_BET_MIN_EDGE", 0.025, 0.0, 0.20),

  // Probability band for value bets — too low is coin-flip noise, too high
  // has near-zero edge because bookmakers price favorites tightly.
  VALUE_BET_MIN_PROB: num("VALUE_BET_MIN_PROB", 0.40, 0.10, 0.95),
  VALUE_BET_MAX_PROB: num("VALUE_BET_MAX_PROB", 0.82, 0.50, 0.99),

  // Minimum independent-source agreement for a value bet. Single-source
  // "value" picks are unreliable — require at least this many sources.
  VALUE_BET_MIN_SOURCES: num("VALUE_BET_MIN_SOURCES", 1, 0, 5),

  // ── Minimum odds floor for value bets ──────────────────────────────────────
  // Picks with odds below this are NOT flagged as value bets even if their
  // edge clears the threshold. Why: a 1.20-odds "value" pick requires risking
  // 100% of stake to win 20% — a single loss wipes out 5 wins. The risk/reward
  // is poor even when the edge is real. Forcing min odds ≥ 1.45 ensures value
  // bets have meaningful upside relative to the capital at risk.
  //
  // Default: 1.45 — excludes sub-1.45 picks (O1.5 at 1.20, heavy favorites).
  // Set to 1.0 to disable the floor entirely (legacy behavior).
  VALUE_BET_MIN_ODDS: num("VALUE_BET_MIN_ODDS", 1.45, 1.0, 3.0),

  // ── Safest High-Odds tier ───────────────────────────────────────────────────
  // A strict tier for picks that combine HIGHER ODDS (more upside) with ALL
  // safety precautions. These are investment-grade picks where the user gets
  // meaningful returns (1.50–2.50 odds) without sacrificing safety.
  //
  // To qualify as a "safe high-odds" pick, ALL of the following must hold:
  //   1. Bookmaker odds in [SAFE_HIGH_ODDS_MIN_ODDS, SAFE_HIGH_ODDS_MAX_ODDS]
  //      (default 1.50–2.50 — meaningful upside without entering longshot zone)
  //   2. Probability ≥ SAFE_HIGH_ODDS_MIN_PROB (default 0.42 — still safe side)
  //   3. Multi-source consensus ≥ SAFE_HIGH_ODDS_MIN_SOURCES (default 1 — was 2,
  //      relaxed because many leagues (e.g. Brasileirão) are only covered by a
  //      single reliable source, which would otherwise leave the Safe High-Odds
  //      tab permanently empty)
  //   4. Edge ≥ SAFE_HIGH_ODDS_MIN_EDGE (default 2% — was 4%, relaxed because
  //      synthetic odds include a ~5% bookmaker margin that makes 4% nearly
  //      unachievable when no real bookmaker odds are available)
  //   5. Kelly stake > 0 (positive expected value)
  //   6. Safe market only — 1X2, O/U 2.5/3.5, BTTS, AH, Double Chance
  //      (excludes correct_score, htft, bet_builder, win_btts which are too
  //      noisy or composite for an investment-grade tier)
  SAFE_HIGH_ODDS_MIN_ODDS: num("SAFE_HIGH_ODDS_MIN_ODDS", 1.50, 1.10, 3.0),
  SAFE_HIGH_ODDS_MAX_ODDS: num("SAFE_HIGH_ODDS_MAX_ODDS", 2.50, 1.50, 5.0),
  SAFE_HIGH_ODDS_MIN_PROB: num("SAFE_HIGH_ODDS_MIN_PROB", 0.42, 0.20, 0.70),
  SAFE_HIGH_ODDS_MIN_SOURCES: num("SAFE_HIGH_ODDS_MIN_SOURCES", 1, 1, 5),
  SAFE_HIGH_ODDS_MIN_EDGE: num("SAFE_HIGH_ODDS_MIN_EDGE", 0.02, 0.0, 0.30),

  // ── Top-pick selection ─────────────────────────────────────────────────────
  // Min probability for a pick to be eligible as a top pick.
  TOP_PICK_MIN_PROB: num("TOP_PICK_MIN_PROB", 0.45, 0.10, 0.95),
  // Sweet-spot band — picks in [lo, hi] are preferred (high enough to be
  // reliable, not so high that the edge is gone).
  TOP_PICK_SWEET_LOW: num("TOP_PICK_SWEET_LOW", 0.55, 0.30, 0.95),
  TOP_PICK_SWEET_HIGH: num("TOP_PICK_SWEET_HIGH", 0.85, 0.50, 0.99),

  // ── Source reliability weighting ───────────────────────────────────────────
  // Window (in days) for trailing Brier score / accuracy when computing
  // source reliability. Sources that have been bad recently get downweighted.
  SOURCE_RELIABILITY_WINDOW_DAYS: num("SOURCE_RELIABILITY_WINDOW_DAYS", 30, 1, 365),

  // Maximum weight a single source can carry — prevents one source from
  // dominating the ensemble.
  SOURCE_MAX_WEIGHT: num("SOURCE_MAX_WEIGHT", 0.40, 0.10, 1.0),

  // Minimum weight — sources never fully vanish; they get a floor so a
  // recent bad streak doesn't permanently kill them.
  SOURCE_MIN_WEIGHT: num("SOURCE_MIN_WEIGHT", 0.05, 0.0, 0.5),

  // ── Per-league calibration ────────────────────────────────────────────────
  // Minimum samples before per-league Platt params are trusted. Below this
  // we fall back to the source-global Platt fit.
  LEAGUE_MIN_SAMPLES: num("LEAGUE_MIN_SAMPLES", 20, 5, 200),

  // ── CLV-based reliability boost ───────────────────────────────────────────
  // If a source's trailing CLV is positive (we beat the closing line), bump
  // its weight by up to this fraction.
  CLV_WEIGHT_BOOST: num("CLV_WEIGHT_BOOST", 0.20, 0.0, 1.0),

  // ── Portfolio-level daily Kelly cap (B1) ───────────────────────────────────
  // Maximum total bankroll exposure across ALL top picks + value bets + safe
  // high-odds picks on a single day. When the sum of per-pick recommended
  // stakes exceeds this fraction, every stake is scaled down pro-rata so the
  // total equals the cap. Default 15% — busy Saturdays can stake 40%+ without
  // this gate, which violates the user's capital-preservation priority.
  //
  // Set to 1.0 to disable (legacy behavior — no portfolio cap).
  DAILY_MAX_EXPOSURE: num("DAILY_MAX_EXPOSURE", 0.15, 0.05, 1.0),

  // ── Drawdown circuit breaker (B2) ──────────────────────────────────────────
  // When the model is in a bad regime, automatically reduce staking.
  // Three states managed by computePerformanceSnapshot in feedback.ts:
  //
  //   "normal"   → stakes at full Kelly (already fractional)
  //   "degraded" → stakes × DRAWDOWN_DEGRADED_FACTOR (default 0.5 = halve)
  //                Triggered by 7-day loseStreak ≥ DRAWDOWN_DEGRADED_STREAK
  //                (default 5) OR rolling drawdown ≥ DRAWDOWN_DEGRADED_PCT
  //                (default 10%).
  //   "halted"   → stakes = 0 (predictions still generated, no stake recommended)
  //                Triggered by drawdown ≥ DRAWDOWN_HALT_PCT (default 20%).
  //
  // Recovery: "degraded" / "halted" → "normal" after
  // DRAWDOWN_RECOVERY_WIN_DAYS (default 3) consecutive winning days.
  DRAWDOWN_DEGRADED_STREAK: num("DRAWDOWN_DEGRADED_STREAK", 5, 2, 15),
  DRAWDOWN_DEGRADED_PCT: num("DRAWDOWN_DEGRADED_PCT", 0.10, 0.03, 0.40),
  DRAWDOWN_HALT_PCT: num("DRAWDOWN_HALT_PCT", 0.20, 0.05, 0.50),
  DRAWDOWN_DEGRADED_FACTOR: num("DRAWDOWN_DEGRADED_FACTOR", 0.5, 0.1, 1.0),
  DRAWDOWN_RECOVERY_WIN_DAYS: num("DRAWDOWN_RECOVERY_WIN_DAYS", 3, 1, 10),

  // ── CLV gate for safest tier + safe-high-odds (B3) ─────────────────────────
  // Per-(market, league) rolling CLV threshold. Picks on (market, league)
  // combos where the engine's trailing CLV is below this value are EXCLUDED
  // from the safe-high-odds tier AND from the safest parlay tier.
  //
  // Default −0.01 — only excludes markets where we systematically lose to
  // the closing line. Set to 0.0 for stricter (only positive-CLV markets).
  MARKET_LEAGUE_MIN_CLV: num("MARKET_LEAGUE_MIN_CLV", -0.01, -0.20, 0.10),

  // Tightened safest parlay leg requirements — investment-grade positioning.
  // Old: minLegProb 0.75. New: 0.80 + minimum 2 sources per leg.
  SAFEST_MIN_LEG_PROB: num("SAFEST_MIN_LEG_PROB", 0.80, 0.55, 0.95),
  SAFEST_MIN_LEG_SOURCES: num("SAFEST_MIN_LEG_SOURCES", 2, 1, 5),

  // ── Goal model (A1) ─────────────────────────────────────────────────────────
  // Dixon-Coles low-score correlation parameter. ρ = -0.05 is the canonical
  // value for soccer (slight under-representation of 0-0, 1-0, 0-1 scores).
  DC_RHO: num("DC_RHO", -0.05, -0.20, 0.20),
  // Weight given to the goal-model prior when blending with tipster consensus.
  // 0 = ignore goal model (legacy behavior), 1 = pure goal model.
  GOALMODEL_PRIOR_WEIGHT: num("GOALMODEL_PRIOR_WEIGHT", 0.30, 0.0, 1.0),

  // ── D1: H2H + Form blend (80/20 model) ─────────────────────────────────────
  // User-driven rebalance: 80% of the probability comes from "diligent research"
  // (H2H history + recent form), 20% from the Poisson goal model.
  // Tipster consensus becomes a small tiebreaker, not the primary driver.
  //
  // Default blend for 1X2:
  //   final = H2H_WEIGHT × h2h_prob
  //         + FORM_WEIGHT × form_prob
  //         + POISSON_WEIGHT × poisson_prob
  //         + TIPSTER_TIEBREAKER_WEIGHT × tipster_prob
  //
  // H2H_WEIGHT + FORM_WEIGHT = 0.80 (the "research" block)
  // POISSON_WEIGHT = 0.20 (the "model" block)
  // TIPSTER_TIEBREAKER_WEIGHT is APPLIED LAST as a small blend on top.
  //
  // When H2H data is missing (only ~30% of matches have it), the H2H weight
  // is reallocated proportionally to FORM + POISSON so the total still = 1.0.
  H2H_WEIGHT: num("H2H_WEIGHT", 0.50, 0.0, 1.0),
  FORM_WEIGHT: num("FORM_WEIGHT", 0.30, 0.0, 1.0),
  POISSON_WEIGHT: num("POISSON_WEIGHT", 0.20, 0.0, 1.0),
  TIPSTER_TIEBREAKER_WEIGHT: num("TIPSTER_TIEBREAKER_WEIGHT", 0.10, 0.0, 0.50),

  // ── Elo team-strength prior (A2) ───────────────────────────────────────────
  // K-factor for Elo updates (higher = more volatile). 20 is standard for
  // club soccer.
  ELO_K: num("ELO_K", 20, 5, 60),
  // Home-field advantage in Elo rating points. 65 ≈ 0.18 in probability.
  ELO_HOME_ADVANTAGE: num("ELO_HOME_ADVANTAGE", 65, 0, 200),
  // Weight given to Elo prior when blending with tipster consensus.
  ELO_PRIOR_WEIGHT: num("ELO_PRIOR_WEIGHT", 0.20, 0.0, 1.0),

  // ── Rest-day / fixture-congestion (A3) ─────────────────────────────────────
  // Per-team penalty applied when rest < REST_PENALTY_THRESHOLD days.
  // Each day below threshold → REST_PENALTY_PER_DAY probability reduction
  // (capped at REST_PENALTY_MAX).
  REST_PENALTY_THRESHOLD: num("REST_PENALTY_THRESHOLD", 3, 1, 10),
  REST_PENALTY_PER_DAY: num("REST_PENALTY_PER_DAY", 0.012, 0.0, 0.05),
  REST_PENALTY_MAX: num("REST_PENALTY_MAX", 0.06, 0.0, 0.15),

  // ── Correlation-aware parlay Kelly (B4) ────────────────────────────────────
  // Haircut on combined parlay probability when legs are correlated.
  // Same-league same-date legs → PARLAY_SAME_LEAGUE_HAIRCUT (default 0.10).
  // 3+ legs within 2-hour window → PARLAY_TIME_CLUSTER_HAIRCUT (default 0.05).
  PARLAY_SAME_LEAGUE_HAIRCUT: num("PARLAY_SAME_LEAGUE_HAIRCUT", 0.10, 0.0, 0.50),
  PARLAY_TIME_CLUSTER_HAIRCUT: num("PARLAY_TIME_CLUSTER_HAIRCUT", 0.05, 0.0, 0.30),
  PARLAY_TIME_CLUSTER_HOURS: num("PARLAY_TIME_CLUSTER_HOURS", 2, 1, 12),

  // ── Source disagreement (C2) ───────────────────────────────────────────────
  // Maximum stdev across per-source probabilities for a pick to be eligible
  // for the safe-high-odds tier. Default 0.15 — filters "lottery 62%" picks
  // (one source 95%, three sources 50%) from investment-grade recommendations.
  SAFE_HIGH_ODDS_MAX_DISAGREEMENT: num("SAFE_HIGH_ODDS_MAX_DISAGREEMENT", 0.15, 0.02, 0.40),

  // ── Daily-loss circuit breaker (B5 — REAL-MONEY SAFETY) ───────────────────
  // Hard stop on the CURRENT day's realized losses, independent of the
  // rolling 7-day drawdown check. The drawdown breaker reacts to a sustained
  // bad regime; the daily-loss breaker reacts to a SINGLE catastrophic day
  // (e.g. 5 of 6 parlays all losing on a Saturday where the model misread
  // a weather event). Without this, a 6-parlay losing day could drain 10%+
  // of bankroll before the rolling window catches up.
  //
  //   MAX_DAILY_LOSS_DEGRADE_PCT — once today's settled losses hit this
  //   fraction of bankroll (default 3%), reduce all remaining stakes by
  //   DAILY_LOSS_DEGRADED_FACTOR (default 0.3 = keep 30% of Kelly).
  //
  //   MAX_DAILY_LOSS_HALT_PCT — once today's settled losses hit this
  //   fraction (default 5%), ZERO all remaining stakes for the day. Manual
  //   review required before resuming (next day's pipeline auto-resumes).
  //
  // The 3% / 5% defaults are calibrated for a 1/8 fractional Kelly bankroll
  // where each parlay stakes ~1-2% of bankroll. Tighten for conservative
  // operations; loosen for higher risk tolerance.
  MAX_DAILY_LOSS_DEGRADE_PCT: num("MAX_DAILY_LOSS_DEGRADE_PCT", 0.03, 0.01, 0.10),
  MAX_DAILY_LOSS_HALT_PCT: num("MAX_DAILY_LOSS_HALT_PCT", 0.05, 0.02, 0.15),
  DAILY_LOSS_DEGRADED_FACTOR: num("DAILY_LOSS_DEGRADED_FACTOR", 0.3, 0.0, 1.0),

  // ── Data-quality gate (B6 — REAL-MONEY SAFETY) ───────────────────────────
  // Before recommending ANY stakes, verify that today's data is fresh and
  // complete enough to trust. If scrapers failed or coverage is too thin,
  // we still BUILD parlays (so the user can see them) but ZERO all stakes
  // — protecting against betting on stale or partial data.
  //
  //   MIN_SCRAPER_SUCCESS_RATE — fraction of enabled scrapers that must
  //   have succeeded in the last 24h. Default 0.70 — at least 70% of
  //   sources must have fresh data. Below this, stakes are zeroed.
  //
  //   MIN_MATCH_COVERAGE — minimum ratio of (matches with ≥1 prediction)
  //   to (total matches today). Default 0.60 — at least 60% of today's
  //   fixtures must have at least one source covering them.
  //
  //   MAX_DATA_AGE_HOURS — max age of the most recent successful scrape.
  //   Default 24h. If the most recent successful scrape is older than this,
  //   stakes are zeroed (data is stale).
  MIN_SCRAPER_SUCCESS_RATE: num("MIN_SCRAPER_SUCCESS_RATE", 0.70, 0.30, 1.0),
  MIN_MATCH_COVERAGE: num("MIN_MATCH_COVERAGE", 0.60, 0.20, 1.0),
  MAX_DATA_AGE_HOURS: num("MAX_DATA_AGE_HOURS", 24, 6, 72),

  // ── Diagnostics ────────────────────────────────────────────────────────────
  LOG_ENGINE_DECISIONS: bool("LOG_ENGINE_DECISIONS", false),
} as const;

export type EngineConfig = typeof ENGINE_CONFIG;
