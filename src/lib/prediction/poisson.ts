/**
 * Bivariate-Poisson / Dixon-Coles Goal Model (A1)
 * ─────────────────────────────────────────────────
 * Fits (λ_home, λ_away) — the expected goals for each team — from a blend of:
 *   - 1X2 implied probabilities (inverse-Poisson optimization)
 *   - O/U 2.5 line (if real book odds are present)
 *   - Tipster consensus as a soft prior
 *
 * Then derives ALL goal markets from the same (λ_h, λ_a) so they're coherent:
 *   - P(over 2.5) = 1 − Σ_{k≤2} Poisson(k; λ_h+λ_a)
 *   - P(BTTS yes) = (1 − e^−λ_h) × (1 − e^−λ_a)
 *   - P(home win) = Σ_{h>a} Poisson(h; λ_h) × Poisson(a; λ_a) × DC_correction
 *   - P(correct score h-a) = Poisson(h; λ_h) × Poisson(a; λ_a) × DC_correction
 *
 * Dixon-Coles correction: ρ parameter (default -0.05) adjusts the 0-0, 1-0,
 * 0-1 score probabilities to match empirical soccer scoring patterns. The
 * naive independent-Poisson model UNDER-estimates low scores and 0-0 draws;
 * the DC correction fixes this.
 *
 * Used as a PRIOR in blendWithPrior() for goal-derived markets. The blend
 * weight is GOALMODEL_PRIOR_WEIGHT (default 0.30) — high enough to enforce
 * cross-market consistency, low enough that tipster consensus can override.
 */

import { ENGINE_CONFIG } from "@/lib/config";

/** Poisson P(X = k) = e^−λ × λ^k / k! */
export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || lambda <= 0) return 0;
  // Use log-space for numerical stability at high k
  const logFact = (n: number): number => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const logPmf = -lambda + k * Math.log(lambda) - logFact(k);
  return Math.exp(logPmf);
}

/** Poisson P(X ≤ k) = Σ_{i=0}^k e^−λ × λ^i / i! */
export function poissonCdf(k: number, lambda: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += poissonPmf(i, lambda);
  return sum;
}

/**
 * Dixon-Coles low-score correction factor.
 *
 *   τ(h, a) = 1 − λ_h × λ_a × ρ        when (h,a) ∈ {(0,0), (0,1), (1,0)}
 *           = 1 + λ_h × λ_a × ρ        when (h,a) = (1,1)
 *           = 1                          otherwise
 *
 * With ρ = -0.05 (default), this INCREASES the probability of 0-0, 1-0, 0-1
 * (low-scoring outcomes) and DECREASES 1-1 slightly. This matches empirical
 * soccer scoring patterns where naive Poisson under-predicts low scores.
 */
export function dixonColesTau(homeGoals: number, awayGoals: number, lambdaHome: number, lambdaAway: number): number {
  const rho = ENGINE_CONFIG.DC_RHO;
  const product = lambdaHome * lambdaAway * rho;
  if (homeGoals === 0 && awayGoals === 0) return 1 - product;
  if (homeGoals === 0 && awayGoals === 1) return 1 - product;
  if (homeGoals === 1 && awayGoals === 0) return 1 - product;
  if (homeGoals === 1 && awayGoals === 1) return 1 + product;
  return 1;
}

export interface GoalModelFit {
  lambdaHome: number;
  lambdaAway: number;
  /** Quality of fit (0-1). Higher = more confident in the fit. */
  confidence: number;
}

/**
 * Fit (λ_home, λ_away) from a 1X2 probability triple and (optionally) an
 * O/U 2.5 line.
 *
 * Approach: parameterize by total expected goals (λ_total = λ_h + λ_a) and
 * home share (s = λ_h / λ_total). Then:
 *   λ_h = s × λ_total
 *   λ_a = (1 - s) × λ_total
 *
 * For a given (λ_total, s):
 *   P(home win) = Σ_{h>a} Poisson(h; λ_h) × Poisson(a; λ_a) × τ(h,a)
 *   P(draw)     = Σ_h Poisson(h; λ_h) × Poisson(h; λ_a) × τ(h,h)
 *   P(away win) = 1 - P(home) - P(draw)
 *   P(over 2.5) = 1 - PoissonCDF(2; λ_total)
 *
 * We do a grid search over (λ_total, s) to minimize the squared error
 * between implied and target probabilities. Grid search is fine — the space
 * is small (λ_total ∈ [0.5, 5.0], s ∈ [0.30, 0.75]).
 */
export function fitGoalModel(
  target: {
    pHome?: number;
    pDraw?: number;
    pAway?: number;
    pOver25?: number;
  }
): GoalModelFit {
  const pHome = target.pHome;
  const pDraw = target.pDraw;
  const pAway = target.pAway;
  const pOver25 = target.pOver25;

  // No targets at all — return a default moderate-scoring match
  if (!pHome && !pDraw && !pAway && !pOver25) {
    return { lambdaHome: 1.45, lambdaAway: 1.15, confidence: 0 };
  }

  let bestFit = { lambdaHome: 1.45, lambdaAway: 1.15, confidence: 0 };
  let bestError = Infinity;

  // Grid search: λ_total ∈ [0.5, 5.0] step 0.1, s ∈ [0.30, 0.75] step 0.02
  for (let lambdaTotal = 0.5; lambdaTotal <= 5.0; lambdaTotal += 0.1) {
    for (let s = 0.30; s <= 0.75; s += 0.02) {
      const lambdaH = s * lambdaTotal;
      const lambdaA = (1 - s) * lambdaTotal;

      // Compute implied probabilities from this (λ_h, λ_a)
      let impliedHome = 0;
      let impliedDraw = 0;
      // Cap at 10 goals each side (more than enough for soccer)
      for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
          if (h === a) {
            impliedDraw += poissonPmf(h, lambdaH) * poissonPmf(a, lambdaA) * dixonColesTau(h, a, lambdaH, lambdaA);
          } else if (h > a) {
            impliedHome += poissonPmf(h, lambdaH) * poissonPmf(a, lambdaA) * dixonColesTau(h, a, lambdaH, lambdaA);
          }
        }
      }
      // Renormalize after DC correction (it can push sum off slightly)
      let impliedAway = 0;
      for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
          if (a > h) {
            impliedAway += poissonPmf(h, lambdaH) * poissonPmf(a, lambdaA) * dixonColesTau(h, a, lambdaH, lambdaA);
          }
        }
      }
      const totalImplied = impliedHome + impliedDraw + impliedAway;
      if (totalImplied > 0) {
        impliedHome /= totalImplied;
        impliedDraw /= totalImplied;
        impliedAway = 1 - impliedHome - impliedDraw;
      }
      const impliedOver25 = 1 - poissonCdf(2, lambdaTotal);

      // Squared error
      let err = 0;
      let nTargets = 0;
      if (pHome !== undefined) { err += (impliedHome - pHome) ** 2; nTargets++; }
      if (pDraw !== undefined) { err += (impliedDraw - pDraw) ** 2; nTargets++; }
      if (pAway !== undefined) { err += (impliedAway - pAway) ** 2; nTargets++; }
      if (pOver25 !== undefined) { err += (impliedOver25 - pOver25) ** 2; nTargets++; }
      if (nTargets === 0) continue;
      const normalizedErr = err / nTargets;

      if (normalizedErr < bestError) {
        bestError = normalizedErr;
        bestFit = {
          lambdaHome: lambdaH,
          lambdaAway: lambdaA,
          confidence: Math.max(0, 1 - Math.sqrt(normalizedErr) * 5), // 0 error → 1, 0.2 error → 0
        };
      }
    }
  }
  return bestFit;
}

/**
 * Compute the full 1X2 probability triple from a goal model fit.
 */
export function goalModel1X2(fit: GoalModelFit): { pHome: number; pDraw: number; pAway: number } {
  const { lambdaHome, lambdaAway } = fit;
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const p = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway) * dixonColesTau(h, a, lambdaHome, lambdaAway);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
    }
  }
  const total = pHome + pDraw + pAway;
  if (total > 0) {
    pHome /= total;
    pDraw /= total;
    pAway /= total;
  }
  return { pHome, pDraw, pAway };
}

/**
 * P(over N.5 goals) = 1 - P(under) = 1 - Σ_{k=0}^{floor(N)} Poisson(k; λ_total)
 */
export function goalModelOverUnder(fit: GoalModelFit, line: number): { pOver: number; pUnder: number } {
  const lambdaTotal = fit.lambdaHome + fit.lambdaAway;
  const floorLine = Math.floor(line);
  const pUnder = poissonCdf(floorLine, lambdaTotal);
  return { pOver: 1 - pUnder, pUnder };
}

/**
 * P(BTTS yes) = (1 - e^−λ_h) × (1 - e^−λ_a)
 * P(BTTS no)  = 1 - P(yes)
 */
export function goalModelBtts(fit: GoalModelFit): { pYes: number; pNo: number } {
  const pHomeScores = 1 - Math.exp(-fit.lambdaHome);
  const pAwayScores = 1 - Math.exp(-fit.lambdaAway);
  const pYes = pHomeScores * pAwayScores;
  return { pYes, pNo: 1 - pYes };
}

/**
 * P(correct score h-a) = Poisson(h; λ_h) × Poisson(a; λ_a) × τ(h,a)
 * (renormalized across all scores)
 */
export function goalModelCorrectScore(fit: GoalModelFit, maxGoals: number = 6): Map<string, number> {
  const { lambdaHome, lambdaAway } = fit;
  const scores = new Map<string, number>();
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway) * dixonColesTau(h, a, lambdaHome, lambdaAway);
      scores.set(`${h}-${a}`, p);
      total += p;
    }
  }
  // Renormalize
  if (total > 0) {
    for (const [key, p] of scores.entries()) {
      scores.set(key, p / total);
    }
  }
  return scores;
}

/**
 * The most likely correct score (mode of the distribution).
 */
export function goalModelMostLikelyScore(fit: GoalModelFit): { score: string; probability: number } {
  const scores = goalModelCorrectScore(fit);
  let bestScore = "1-1";
  let bestP = 0;
  for (const [score, p] of scores.entries()) {
    if (p > bestP) {
      bestP = p;
      bestScore = score;
    }
  }
  return { score: bestScore, probability: bestP };
}
