/**
 * Kelly Criterion Staking
 * ────────────────────────
 * The Kelly criterion maximizes long-run bankroll growth for repeated bets
 * with a positive edge. For decimal odds `b` (where b = decimal_odds - 1)
 * and win probability `p`:
 *
 *   f* = (b * p - q) / b   where q = 1 - p
 *
 * i.e. bet the fraction of your bankroll equal to (edge / (odds - 1)).
 *
 * In practice, full Kelly is too aggressive — variance is brutal and any
 * overestimation of `p` leads to ruin. Standard practice is fractional Kelly:
 *
 *   - 1/4 Kelly: conservative (recommended for most bettors)
 *   - 1/2 Kelly: aggressive
 *   - Full Kelly: theoretical optimum, very risky in practice
 *
 * We use 1/4 Kelly by default and cap the stake at 5% of bankroll to prevent
 * catastrophic single-bet losses.
 *
 * For parlays (accumulators), Kelly still applies but variance is even higher
 * — we use 1/8 Kelly for parlays to be extra conservative.
 */

export interface KellyResult {
  fullKelly: number;      // f* — fraction of bankroll (0 to ~1, can be negative)
  fractionalKelly: number; // 1/4 of f*, clamped to [0, maxStake]
  recommendedStake: number; // final stake as % of bankroll (0-0.05)
  edge: number;            // b * p - 1 (expected value per unit staked)
  isPositive: boolean;     // true if edge > 0
}

/**
 * Compute Kelly stake for a single bet.
 *
 * @param probability  Estimated probability of winning (0-1)
 * @param decimalOdds  Bookmaker decimal odds (e.g. 2.10)
 * @param fraction     Kelly fraction (default 0.25 = quarter Kelly)
 * @param maxStake     Cap on recommended stake as fraction of bankroll (default 0.05)
 */
export function kelly(
  probability: number,
  decimalOdds: number,
  fraction: number = 0.25,
  maxStake: number = 0.05
): KellyResult {
  const p = Math.max(0.001, Math.min(0.999, probability));
  const b = decimalOdds - 1;
  if (b <= 0) {
    // Odds <= 1.0 are nonsensical or break-even — no bet
    return { fullKelly: 0, fractionalKelly: 0, recommendedStake: 0, edge: 0, isPositive: false };
  }
  const q = 1 - p;
  const fullKelly = (b * p - q) / b;
  const edge = b * p - q; // = fullKelly * b
  const isPositive = edge > 0;

  // If edge is negative, Kelly says don't bet → 0
  const fk = Math.max(0, fullKelly);
  const fractionalKelly = fk * fraction;

  // Clamp to [0, maxStake]
  const recommendedStake = Math.max(0, Math.min(maxStake, fractionalKelly));

  return {
    fullKelly: fk,
    fractionalKelly,
    recommendedStake,
    edge,
    isPositive,
  };
}

/**
 * Compute Kelly stake for a parlay (accumulator).
 *
 * For a parlay with N legs, the combined probability is the product of leg
 * probabilities (assuming independence), and combined odds is the product of
 * leg odds. Kelly then applies as usual.
 *
 * Because parlay variance is much higher than single-bet variance, we use a
 * smaller Kelly fraction (default 1/8) and a tighter stake cap (default 2%).
 */
export function kellyParlay(
  combinedProbability: number,
  combinedOdds: number,
  legsCount: number,
  fraction: number = 0.125,
  maxStake: number = 0.02
): KellyResult {
  // Additional conservatism for long parlays: scale fraction down by leg count
  const legAdjustedFraction = fraction * Math.max(0.5, 1 - (legsCount - 2) * 0.1);
  return kelly(combinedProbability, combinedOdds, legAdjustedFraction, maxStake);
}

/**
 * Format a Kelly stake as a percentage string for display.
 */
export function formatKelly(stake: number): string {
  if (stake <= 0) return "0%";
  if (stake < 0.001) return "<0.1%";
  return `${(stake * 100).toFixed(2)}%`;
}

/**
 * Suggested bankroll allocation in monetary units, given a bankroll size.
 */
export function stakeAmount(stake: number, bankroll: number): number {
  return stake * bankroll;
}
