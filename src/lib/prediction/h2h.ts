/**
 * H2H (Head-to-Head) Probability Model
 * ─────────────────────────────────────
 * Parses ESPN's H2H summary (last 10 meetings between two specific teams) and
 * converts it into a pHome/pDraw/pAway probability vector.
 *
 * Why H2H matters:
 *   - Team A may be in great recent form (last 5: WWWWW) but historically lose
 *     to Team B (H2H: 1W-2D-7L). The historical matchup captures stylistic
 *     mismatches that generic form misses — e.g. a counter-attacking side that
 *     consistently beats a possession side.
 *   - H2H is the single most-used "research" signal by serious bettors.
 *
 * Recency weighting:
 *   - Most recent meeting gets weight 1.0; oldest (10th) gets weight 0.1
 *   - Linear decay: weight_i = 1.0 - (i / (N + 1))  for i = 0..N-1
 *   - This way a 2024 meeting counts ~10x more than a 2019 meeting
 *
 * Venue correction:
 *   - H2H games alternate venues. We don't know which team was home in each
 *     historical game, so we treat wins/losses/draws as opponent-relative
 *     (not venue-relative) and apply a small home-field advantage constant.
 *
 * Sample-size shrinkage:
 *   - With only 1-2 H2H meetings, the data is too thin to be conclusive.
 *   - We shrink toward a baseline of [0.40, 0.27, 0.33] (typical home/draw/away
 *     for top-5 European leagues) by a factor that depends on N.
 *   - shrinkage = N / (N + 5)  → N=0: 0% trust, N=5: 50% trust, N=10: 67% trust
 */

export interface H2HMatch {
  date: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  result: "home" | "away" | "draw";
}

export interface H2HSummary {
  totalGames: number;
  homeWins: number;
  awayWins: number;
  draws: number;
  lastMatches: H2HMatch[];
}

export interface H2HProbability {
  pHome: number;
  pDraw: number;
  pAway: number;
  sampleSize: number;
  /** 0-1 confidence in the H2H signal (drives shrinkage). */
  confidence: number;
}

// Baseline 1X2 probabilities for top-5 European leagues (home advantage included).
// Used for shrinkage when H2H sample is small.
const BASELINE = { pHome: 0.40, pDraw: 0.27, pAway: 0.33 };

/**
 * Parse a JSON string from Match.h2hJson into an H2HSummary.
 * Returns null if the JSON is malformed or empty.
 */
export function parseH2HJson(h2hJson: string | null | undefined): H2HSummary | null {
  if (!h2hJson) return null;
  try {
    const parsed = JSON.parse(h2hJson) as H2HSummary;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray(parsed.lastMatches)) return null;
    if (parsed.lastMatches.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Compute H2H-based pHome/pDraw/pAway from ESPN's H2H summary.
 *
 * The H2H summary uses "home"/"away" labels relative to the ESPN canonical
 * home/away for the upcoming match — so "homeWins" in the summary means
 * "the team that will be home in the upcoming match won that many H2H games."
 *
 * Algorithm:
 *   1. Walk lastMatches (most recent first), apply linear recency weight.
 *   2. Tally weighted wins/draws/losses for the upcoming-home team.
 *   3. Normalize to a probability vector.
 *   4. Apply shrinkage toward BASELINE based on sample size.
 *   5. Apply small home-field advantage bump (+0.04 to pHome, -0.02 each from pDraw/pAway).
 *
 * Returns null if no H2H data is available.
 */
export function h2hProbability(h2hJson: string | null | undefined): H2HProbability | null {
  const summary = parseH2HJson(h2hJson);
  if (!summary) return null;

  const matches = summary.lastMatches;
  const N = matches.length;
  if (N === 0) return null;

  // ── Recency-weighted tally ────────────────────────────────────────────────
  // Most recent match (index 0) gets weight 1.0; linear decay to oldest.
  let wHome = 0, wDraw = 0, wAway = 0, wSum = 0;
  for (let i = 0; i < N; i++) {
    const w = 1.0 - i / (N + 1); // 1.0, 0.9, 0.8, ..., 1/(N+1)
    const m = matches[i];
    // H2HMatch.result is "home"/"away"/"draw" — relative to upcoming match's
    // home team (because ESPN's H2H summary is keyed to the upcoming fixture).
    if (m.result === "home") wHome += w;
    else if (m.result === "away") wAway += w;
    else wDraw += w;
    wSum += w;
  }

  if (wSum === 0) return null;

  // Normalize to probability vector
  let pHome = wHome / wSum;
  let pDraw = wDraw / wSum;
  let pAway = wAway / wSum;

  // ── Shrinkage toward baseline based on sample size ────────────────────────
  // shrinkage = N / (N + 5) → N=1: 0.17, N=3: 0.38, N=5: 0.50, N=10: 0.67
  const shrinkage = Math.min(0.85, N / (N + 5));
  pHome = pHome * shrinkage + BASELINE.pHome * (1 - shrinkage);
  pDraw = pDraw * shrinkage + BASELINE.pDraw * (1 - shrinkage);
  pAway = pAway * shrinkage + BASELINE.pAway * (1 - shrinkage);

  // ── Home-field advantage bump (small — H2H already includes venue effects) ─
  // Only apply if we have enough data; otherwise we'd double-count.
  if (N >= 3) {
    pHome += 0.04;
    pDraw -= 0.02;
    pAway -= 0.02;
  }

  // Re-normalize after adjustments
  const s = pHome + pDraw + pAway;
  if (s > 0) {
    pHome /= s;
    pDraw /= s;
    pAway /= s;
  }

  // Clamp to reasonable bounds (avoid 0% or 100% — never be that confident from H2H alone)
  const clamp = (p: number) => Math.max(0.05, Math.min(0.85, p));
  pHome = clamp(pHome);
  pDraw = clamp(pDraw);
  pAway = clamp(pAway);

  // Final renormalize
  const s2 = pHome + pDraw + pAway;
  pHome /= s2;
  pDraw /= s2;
  pAway /= s2;

  return {
    pHome,
    pDraw,
    pAway,
    sampleSize: N,
    confidence: shrinkage,
  };
}

/**
 * Get the H2H-based probability for a specific 1X2 selection.
 * Helper for the engine's blend math.
 */
export function h2hProbabilityForSelection(
  h2hJson: string | null | undefined,
  selection: "1" | "X" | "2"
): { probability: number; sampleSize: number; confidence: number } | null {
  const h2h = h2hProbability(h2hJson);
  if (!h2h) return null;
  const probability = selection === "1" ? h2h.pHome : selection === "2" ? h2h.pAway : h2h.pDraw;
  return {
    probability,
    sampleSize: h2h.sampleSize,
    confidence: h2h.confidence,
  };
}
