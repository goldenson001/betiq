/**
 * Safe High-Odds — shared evaluation utility
 * -------------------------------------------
 * The "Safe High-Odds" tier combines HIGHER ODDS (1.50–2.50) with ALL safety
 * precautions: multi-source consensus, strong edge, positive Kelly stake, safe
 * market. The result is surfaced in the dedicated "Safe High-Odds" tab on the
 * dashboard.
 *
 * This module exists so the criteria can be evaluated in TWO places from a
 * single source of truth:
 *   1. The prediction engine (persisted to Prediction.isSafeHighOdds when a
 *      prediction is first generated)
 *   2. The /api/stats route (re-evaluated on-the-fly using the CURRENT config
 *      so users see immediate relief when thresholds are relaxed — without
 *      needing an admin `?force=true` pipeline re-run)
 *
 * The DB-stored flag remains the canonical value used by the feedback loop
 * for CLV tracking; the on-the-fly evaluation only affects what's DISPLAYED.
 */

import { ENGINE_CONFIG } from "@/lib/config";
import { kelly as kellyStake } from "@/lib/learning/kelly";

/**
 * Markets eligible for the Safe High-Odds tier.
 * Composite/noisy markets (correct_score, htft, bet_builder, win_btts) are
 * excluded — they're too volatile for an investment-grade tier.
 */
export const SAFE_HIGH_ODDS_MARKETS = new Set([
  "1x2",
  "ou25",
  "ou35",
  "btts",
  "asian_handicap",
  "double_chance",
  "dnb",
]);

/**
 * Minimal prediction-like shape required by the evaluator.
 * Both the engine's internal EnginePrediction and the DB's Prediction row
 * satisfy this contract.
 */
export interface SafeHighOddsPickLike {
  market: string;
  bookOdds?: number | null | undefined;
  probability: number;
  consensusSources?: number | null | undefined;
  edge?: number | null | undefined;
  disagreement?: number | null | undefined;
}

/**
 * Options for the evaluator.
 *   - marketLeagueClv: optional Map keyed by `${market}|${leagueId}` →
 *     rolling CLV. When absent, the CLV gate is skipped (same behavior as
 *     the engine when the CLV map is empty — fresh DB, no feedback yet).
 *   - leagueId: used to look up `marketLeagueClv`. When omitted, the CLV
 *     gate is skipped.
 */
export interface SafeHighOddsEvalOptions {
  marketLeagueClv?: Map<string, number> | null;
  leagueId?: string | null;
}

/**
 * Returns `true` if a prediction meets ALL Safe High-Odds criteria:
 *   1. market ∈ SAFE_HIGH_ODDS_MARKETS
 *   2. bookOdds ∈ [SAFE_HIGH_ODDS_MIN_ODDS, SAFE_HIGH_ODDS_MAX_ODDS]
 *   3. probability ≥ SAFE_HIGH_ODDS_MIN_PROB
 *   4. consensusSources ≥ SAFE_HIGH_ODDS_MIN_SOURCES
 *   5. edge ≥ SAFE_HIGH_ODDS_MIN_EDGE
 *   6. CLV gate (only when marketLeagueClv is provided AND has an entry for
 *      this market+league — picks on combos we systematically lose to the
 *      closing line are excluded)
 *   7. disagreement ≤ SAFE_HIGH_ODDS_MAX_DISAGREEMENT (only when defined)
 *   8. Kelly fullKelly > 0 (positive expected value)
 *
 * Pure function — no side effects, no DB access. Safe to call from API routes.
 */
export function isSafeHighOddsPick(
  p: SafeHighOddsPickLike,
  opts: SafeHighOddsEvalOptions = {}
): boolean {
  if (!SAFE_HIGH_ODDS_MARKETS.has(p.market)) return false;

  const odds = p.bookOdds ?? 0;
  if (odds < ENGINE_CONFIG.SAFE_HIGH_ODDS_MIN_ODDS) return false;
  if (odds > ENGINE_CONFIG.SAFE_HIGH_ODDS_MAX_ODDS) return false;
  if (p.probability < ENGINE_CONFIG.SAFE_HIGH_ODDS_MIN_PROB) return false;
  if ((p.consensusSources ?? 0) < ENGINE_CONFIG.SAFE_HIGH_ODDS_MIN_SOURCES) return false;
  if ((p.edge ?? 0) < ENGINE_CONFIG.SAFE_HIGH_ODDS_MIN_EDGE) return false;

  // B3: per-(market, league) CLV gate — only fires when a CLV entry exists
  if (opts.marketLeagueClv && opts.leagueId) {
    const clvKey = `${p.market}|${opts.leagueId}`;
    const mlClv = opts.marketLeagueClv.get(clvKey);
    if (mlClv !== undefined && mlClv < ENGINE_CONFIG.MARKET_LEAGUE_MIN_CLV) {
      return false;
    }
  }

  // C2: disagreement gate — exclude "lottery" picks where sources strongly
  // disagree. Only fires when disagreement is defined.
  if (
    p.disagreement !== undefined &&
    p.disagreement !== null &&
    p.disagreement > ENGINE_CONFIG.SAFE_HIGH_ODDS_MAX_DISAGREEMENT
  ) {
    return false;
  }

  // Kelly check — full Kelly must be positive (positive expected value)
  if (!p.bookOdds || p.bookOdds <= 1) return false;
  const k = kellyStake(p.probability, p.bookOdds);
  if (k.fullKelly <= 0) return false;

  return true;
}
