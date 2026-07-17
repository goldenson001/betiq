/**
 * Platt Scaling (Logistic Calibration)
 * ─────────────────────────────────────
 * Each source's raw probability estimates are often miscalibrated — a source
 * might say "70% likely" but only be right 55% of the time. Platt scaling
 * fits a logistic regression on top of the source's stated probabilities:
 *
 *   P(actual | source says p) = sigmoid(a * p + b)
 *
 * where `a` and `b` are fit from historical (predicted, outcome) pairs.
 *
 * - If the source is perfectly calibrated: a=1, b=0 (identity).
 * - If the source is overconfident:        a<1 (compresses toward 0.5).
 * - If the source is underconfident:       a>1 (stretches away from 0.5).
 * - Bias term `b` shifts the curve left/right.
 *
 * We use gradient descent on the cross-entropy loss, with L2 regularization
 * to keep the fit stable for sources with few samples. The fitting runs in
 * the feedback loop after every batch of evaluated matches.
 *
 * Reference: Platt, J. (1999) "Probabilistic Outputs for Support Vector
 * Machines and Comparisons to Regularized Likelihood Methods".
 */

/** Logistic sigmoid, numerically stable for large |x|. */
export function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

/** Apply Platt calibration to a raw probability. */
export function applyPlatt(
  p: number,
  a: number,
  b: number
): number {
  // Clamp input to (0.001, 0.999) so log() never blows up downstream
  const clamped = Math.max(0.001, Math.min(0.999, p));
  return sigmoid(a * clamped + b);
}

export interface PlattParams {
  a: number;
  b: number;
  n: number; // sample count
  loss: number; // final cross-entropy loss
}

/**
 * Fit Platt scaling parameters (a, b) from a list of (predicted, outcome)
 * pairs using gradient descent on cross-entropy loss with L2 regularization.
 *
 * @param samples  Array of {pred, actual} pairs (pred ∈ [0,1], actual ∈ {0,1})
 * @param opts     Optional fitting hyperparameters
 * @returns        Fitted PlattParams
 */
export function fitPlatt(
  samples: Array<{ pred: number; actual: number }>,
  opts: { epochs?: number; lr?: number; l2?: number } = {}
): PlattParams {
  const { epochs = 400, lr = 0.5, l2 = 0.01 } = opts;

  if (samples.length === 0) {
    return { a: 1, b: 0, n: 0, loss: 0 };
  }
  if (samples.length < 10) {
    // Too few samples to fit reliably — return identity but track count
    return { a: 1, b: 0, n: samples.length, loss: 0 };
  }

  // Initialize from a quick closed-form estimate (least-squares on logits)
  // — gives gradient descent a head start and avoids pathological local minima.
  let a = 1;
  let b = 0;
  try {
    const valid = samples.filter((s) => s.pred > 0.01 && s.pred < 0.99 && s.actual >= 0 && s.actual <= 1);
    if (valid.length >= 10) {
      const n = valid.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const s of valid) {
        const x = s.pred;
        // Pseudo-logit: ln(p/(1-p)) but on the OUTCOME side via inverse sigmoid
        // We linearize: logit(actual_smoothed) ≈ a*pred + b
        const smoothed = s.actual === 1 ? 0.975 : 0.025;
        const y = Math.log(smoothed / (1 - smoothed));
        sx += x; sy += y; sxx += x * x; sxy += x * y;
      }
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) > 1e-9) {
        a = Math.max(0.1, Math.min(5, (n * sxy - sx * sy) / denom));
        b = Math.max(-3, Math.min(3, (sy - a * sx) / n));
      }
    }
  } catch {
    // fall through to gradient descent with defaults
  }

  // Gradient descent
  for (let epoch = 0; epoch < epochs; epoch++) {
    let gradA = 0;
    let gradB = 0;
    let loss = 0;
    for (const s of samples) {
      const p = Math.max(0.001, Math.min(0.999, s.pred));
      const z = a * p + b;
      const pred = sigmoid(z);
      const err = pred - s.actual;
      gradA += err * p;
      gradB += err;
      // Cross-entropy loss
      loss -= s.actual * Math.log(pred + 1e-9) + (1 - s.actual) * Math.log(1 - pred + 1e-9);
    }
    const n = samples.length;
    gradA = gradA / n + l2 * a;
    gradB = gradB / n + l2 * b;
    a -= lr * gradA;
    b -= lr * gradB;
    // Clamp to sensible ranges
    a = Math.max(0.1, Math.min(5, a));
    b = Math.max(-3, Math.min(3, b));

    if (epoch === epochs - 1) {
      return { a, b, n: samples.length, loss: loss / n };
    }
  }

  return { a, b, n: samples.length, loss: 0 };
}

/**
 * Brier score — mean squared error between predicted probabilities and
 * outcomes. Lower is better. 0 = perfect, 0.25 = always predict 0.5.
 *
 * Used to track calibration quality over time in PerformanceSnapshot.
 */
export function brierScore(
  samples: Array<{ pred: number; actual: number }>
): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    const d = s.pred - s.actual;
    sum += d * d;
  }
  return sum / samples.length;
}

/**
 * Reliability curve — bucket predictions into deciles and compute the
 * empirical accuracy per bucket. Useful for diagnostics.
 */
export function reliabilityCurve(
  samples: Array<{ pred: number; actual: number }>,
  buckets: number = 10
): Array<{ bucket: number; meanPred: number; empirical: number; count: number }> {
  const result: Array<{ bucket: number; meanPred: number; empirical: number; count: number }> = [];
  for (let i = 0; i < buckets; i++) {
    const lo = i / buckets;
    const hi = (i + 1) / buckets;
    const inBucket = samples.filter((s) => s.pred >= lo && (i === buckets - 1 ? s.pred <= hi : s.pred < hi));
    if (inBucket.length === 0) {
      result.push({ bucket: i, meanPred: (lo + hi) / 2, empirical: 0, count: 0 });
      continue;
    }
    const meanPred = inBucket.reduce((s, x) => s + x.pred, 0) / inBucket.length;
    const empirical = inBucket.reduce((s, x) => s + x.actual, 0) / inBucket.length;
    result.push({ bucket: i, meanPred, empirical, count: inBucket.length });
  }
  return result;
}
