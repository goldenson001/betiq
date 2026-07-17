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
  //   3. Multi-source consensus ≥ SAFE_HIGH_ODDS_MIN_SOURCES (default 2 — no
  //      single-source picks allowed; broad agreement required)
  //   4. Edge ≥ SAFE_HIGH_ODDS_MIN_EDGE (default 4% — well above noise floor)
  //   5. Kelly stake > 0 (positive expected value)
  //   6. Safe market only — 1X2, O/U 2.5/3.5, BTTS, AH, Double Chance
  //      (excludes correct_score, htft, bet_builder, win_btts which are too
  //      noisy or composite for an investment-grade tier)
  SAFE_HIGH_ODDS_MIN_ODDS: num("SAFE_HIGH_ODDS_MIN_ODDS", 1.50, 1.10, 3.0),
  SAFE_HIGH_ODDS_MAX_ODDS: num("SAFE_HIGH_ODDS_MAX_ODDS", 2.50, 1.50, 5.0),
  SAFE_HIGH_ODDS_MIN_PROB: num("SAFE_HIGH_ODDS_MIN_PROB", 0.42, 0.20, 0.70),
  SAFE_HIGH_ODDS_MIN_SOURCES: num("SAFE_HIGH_ODDS_MIN_SOURCES", 2, 1, 5),
  SAFE_HIGH_ODDS_MIN_EDGE: num("SAFE_HIGH_ODDS_MIN_EDGE", 0.04, 0.0, 0.30),

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

  // ── Diagnostics ────────────────────────────────────────────────────────────
  LOG_ENGINE_DECISIONS: bool("LOG_ENGINE_DECISIONS", false),
} as const;

export type EngineConfig = typeof ENGINE_CONFIG;
