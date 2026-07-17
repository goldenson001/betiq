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
