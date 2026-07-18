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

// ──────────────────────────────────────────────────────────────────────────────
// H2H → ML reliability component
// ──────────────────────────────────────────────────────────────────────────────

/**
 * H2H agreement score for the ML reliability model.
 *
 * Returns a value in [0, 1] expressing how strongly the historical head-to-
 * head record ENDORSES the prediction's selection. Higher = safer leg.
 *
 * The score blends TWO sub-signals:
 *
 *   1. Agreement (0..1) — how much the H2H probability for the selection
 *      exceeds a neutral baseline of 0.33. A selection that H2H gives ≥50%
 *      to scores ≥0.5; a selection H2H gives <30% to scores <0.3.
 *
 *   2. Sample confidence (0..1) — how much we trust the H2H data itself,
 *      based on sample size. <3 games → 0.20, 3-5 → 0.50, 6-9 → 0.75,
 *      10+ → 0.90.
 *
 * Final score = agreement × 0.7 + sampleConfidence × 0.3
 *
 * Market-aware:
 *   - 1x2, dnb, double_chance — direct lookup against H2H 1X2 probs
 *   - ou25 / ou15 / ou35 — derived from H2H avg goals per game
 *   - btts — derived from H2H % of games where both teams scored
 *   - other markets (asian_handicap, corners, cards, bet_builder, etc.) —
 *     use generic "predictability" signal: how dominant was the most common
 *     H2H outcome? A 7W-2D-1L pattern is more predictable than 4W-3D-3L.
 *
 * Returns null if no H2H data is available — the ML model will use 0.5
 * (neutral) in that case.
 */
export interface H2HAgreementResult {
  /** Final H2H score in [0, 1] — higher = H2H endorses the pick. */
  score: number;
  /** Sub-signal: agreement between H2H and the pick (0..1). */
  agreement: number;
  /** Sub-signal: trust in the H2H sample itself (0..1). */
  sampleConfidence: number;
  /** Sample size (number of H2H games). */
  sampleSize: number;
  /** Short human-readable explanation for UI tooltips. */
  label: string;
}

export function computeH2HAgreement(
  h2hJson: string | null | undefined,
  market: string,
  selection: string
): H2HAgreementResult | null {
  const summary = parseH2HJson(h2hJson);
  if (!summary) return null;

  const N = summary.lastMatches.length;
  if (N === 0) return null;

  // Sample confidence — saturates at 10 games.
  const sampleConfidence = N >= 10 ? 0.90
    : N >= 6 ? 0.75
    : N >= 3 ? 0.50
    : 0.20;

  // ── Market-aware agreement ──────────────────────────────────────────────
  let agreement = 0.5; // neutral default
  let label = "";

  const marketLower = market.toLowerCase();

  if (marketLower === "1x2" || marketLower === "dnb" || marketLower === "double_chance") {
    // Direct 1X2 lookup. For DNB, "1" → home win, "2" → away win (draw = void).
    // For double_chance, selection may be "1X", "12", or "X2".
    const h2h = h2hProbability(h2hJson);
    if (h2h) {
      let p = 0;
      if (marketLower === "double_chance") {
        const sel = selection.toUpperCase();
        if (sel === "1X") p = h2h.pHome + h2h.pDraw;
        else if (sel === "X2") p = h2h.pDraw + h2h.pAway;
        else if (sel === "12") p = h2h.pHome + h2h.pAway;
        else p = 0.5;
      } else {
        // "1" / "X" / "2"
        const sel = selection.toUpperCase() === "1" ? "1"
          : selection.toUpperCase() === "2" ? "2"
          : "X";
        p = sel === "1" ? h2h.pHome : sel === "2" ? h2h.pAway : h2h.pDraw;
      }
      // Map [0, 1] → agreement score:
      //   p >= 0.60 → 0.85+ (strong endorsement)
      //   p ~ 0.50 → 0.65 (mild endorsement)
      //   p ~ 0.33 → 0.50 (neutral)
      //   p < 0.25 → 0.20 (H2H actively contradicts the pick)
      agreement = Math.max(0.10, Math.min(0.95,
        0.5 + (p - 0.33) * 1.8
      ));
      label = `H2H ${selection.toUpperCase()}: ${Math.round(p * 100)}%`;
    }
  } else if (marketLower === "ou25" || marketLower === "ou15" || marketLower === "ou35") {
    // Derive avg goals from H2H last matches
    let totalGoals = 0;
    for (const m of summary.lastMatches) {
      totalGoals += m.homeScore + m.awayScore;
    }
    const avgGoals = totalGoals / N;
    const threshold = marketLower === "ou15" ? 1.5
      : marketLower === "ou35" ? 3.5
      : 2.5;
    const sel = selection.toLowerCase();
    const isOver = sel.startsWith("over") || sel === "o" || sel.startsWith("o ");
    // P(over) ≈ Poisson(avgGoals) for goals > threshold.
    // Simple approximation: ratio of games above threshold
    let overCount = 0;
    for (const m of summary.lastMatches) {
      if (m.homeScore + m.awayScore > threshold) overCount++;
    }
    const observedOverPct = overCount / N;
    const p = isOver ? observedOverPct : 1 - observedOverPct;
    agreement = Math.max(0.10, Math.min(0.95,
      0.5 + (p - 0.5) * 1.6
    ));
    label = `H2H avg ${avgGoals.toFixed(1)} goals · ${isOver ? "Over" : "Under"} ${threshold}: ${Math.round(p * 100)}%`;
  } else if (marketLower === "btts") {
    // BTTS — % of H2H games where both teams scored
    let bttsCount = 0;
    for (const m of summary.lastMatches) {
      if (m.homeScore > 0 && m.awayScore > 0) bttsCount++;
    }
    const bttsPct = bttsCount / N;
    const sel = selection.toLowerCase();
    const isYes = sel === "yes" || sel === "y" || sel.includes("yes");
    const p = isYes ? bttsPct : 1 - bttsPct;
    agreement = Math.max(0.10, Math.min(0.95,
      0.5 + (p - 0.5) * 1.6
    ));
    label = `H2H BTTS ${isYes ? "Yes" : "No"}: ${Math.round(p * 100)}%`;
  } else {
    // Generic "predictability" — how dominant is the most common H2H outcome?
    // A 7W-2D-1L pattern (70% one outcome) is highly predictable → 0.80.
    // A 4W-3D-3L pattern (40% top outcome) is chaotic → 0.45.
    const counts = [summary.homeWins, summary.awayWins, summary.draws].sort((a, b) => b - a);
    const dominantShare = counts[0] / N;
    agreement = Math.max(0.20, Math.min(0.85,
      0.35 + dominantShare * 0.6
    ));
    label = `H2H dominant outcome: ${Math.round(dominantShare * 100)}%`;
  }

  const score = Math.max(0.05, Math.min(0.95,
    agreement * 0.7 + sampleConfidence * 0.3
  ));

  return { score, agreement, sampleConfidence, sampleSize: N, label };
}
