/**
 * ML Weight Backtester
 * ─────────────────────
 * Grid-searches `ML_WEIGHTS` (the 6 de-correlated weights) against historical
 * settled matches and reports the best-performing combination.
 *
 * METRICS (computed per weight combo):
 *   1. Calibration Brier — mean((adjustedProb - actualOutcome)²) over all
 *      settled legs. Lower = better-calibrated. This is the PRIMARY metric.
 *   2. Top-decile hit rate — legs in the top 10% by reliability, what %
 *      were actually correct? Higher = better discrimination.
 *   3. Safest-tier simulated ROI — flat 1u bets on every leg with
 *      reliability ≥ 0.70, summed P/L divided by number of bets. Higher =
 *      more profitable "safe" picks.
 *   4. Bottom-decile loss rate — legs in bottom 10% by reliability, what %
 *      were wrong? Higher = better discrimination (we WANT the bottom to lose).
 *
 * SCORING:
 *   Each combo gets a z-score on each metric, then a weighted sum:
 *     z(Brier) × -1.0   (negative because lower is better)
 *     z(TopDecile) × +0.5
 *     z(ROI) × +0.5
 *     z(BottomLoss) × +0.3
 *   Higher composite = better. We print the top 5 combos.
 *
 * USAGE:
 *   bun run scripts/backtest-weights.ts [startDate] [endDate]
 *   # defaults to last 60 days
 *
 *   Example:
 *   bun run scripts/backtest-weights.ts 2026-05-01 2026-07-15
 */

import { db } from "../src/lib/db";
import {
  computeLegMLScoreWithWeights,
  isValidWeightVector,
  type LegInput,
} from "../src/lib/learning/parlay-ml";
import { loadSourceMLInfo } from "../src/lib/learning/parlay-ml";
import { loadMarketLeagueClvMap } from "../src/lib/learning/feedback";
import { brierScore } from "../src/lib/learning/calibration";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface WeightCombo {
  prob: number;
  sourceCohesion: number;
  marketClv: number;
  sourceQuality: number;
  tierHistory: number;
  h2h: number;
}

interface LegEvaluation {
  predictionId: string;
  matchLabel: string;
  market: string;
  selection: string;
  bookOdds: number | null;
  actualOutcome: boolean; // did this pick win?
  // Computed per weight combo:
  reliability: number;
  adjustedProb: number;
}

interface ComboResult {
  combo: WeightCombo;
  brier: number;
  topDecileHitRate: number;
  bottomDecileLossRate: number;
  safestRoi: number;
  safestBetsCount: number;
  compositeScore: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const startDate = process.argv[2] ?? defaultStartDate();
  const endDate = process.argv[3] ?? todayDate();

  console.log("═".repeat(78));
  console.log("  ML Weight Backtester — de-correlated v2 model");
  console.log("═".repeat(78));
  console.log(`  Date range: ${startDate} → ${endDate}`);
  console.log();

  // ── 1. Load settled matches + their evaluated predictions ──────────────
  console.log("  [1/4] Loading settled matches + predictions...");
  const matches = await db.match.findMany({
    where: {
      matchDate: { gte: startDate, lte: endDate },
      status: "finished",
      homeScore: { not: null },
      awayScore: { not: null },
    },
    include: {
      predictions: {
        where: { evaluated: true, correct: { not: null } },
      },
    },
  });

  let totalPredictions = 0;
  for (const m of matches) totalPredictions += m.predictions.length;
  console.log(`        → ${matches.length} matches, ${totalPredictions} evaluated predictions`);
  console.log();

  if (totalPredictions === 0) {
    console.error("  ✗ No settled predictions in date range — nothing to backtest.");
    console.error("    Run the feedback loop first on historical dates, or pick a different range.");
    process.exit(1);
  }

  // ── 2. Load source ML info + market-league CLV map ────────────────────
  console.log("  [2/4] Loading source ML info + market-league CLV map...");
  const sourceMLMap = await loadSourceMLInfo();
  const marketClvMap = await loadMarketLeagueClvMap();
  console.log(`        → ${sourceMLMap.size} sources, ${marketClvMap.size} (market,league) CLV rows`);
  console.log();

  // ── 3. Build LegInput for every settled prediction (once) ──────────────
  console.log("  [3/4] Building LegInput for each settled prediction...");
  const legInputs: Array<LegInput & { actualOutcome: boolean; bookOdds: number | null; label: string }> = [];

  for (const m of matches) {
    for (const p of m.predictions) {
      if (p.correct === null) continue;

      // Parse sourcesJson → per-source info
      let sources: LegInput["sources"] = [];
      try {
        const srcArr = JSON.parse(p.sourcesJson ?? "[]") as Array<{ source?: string; probability?: number }>;
        for (const s of srcArr) {
          if (s.source && typeof s.probability === "number" && s.probability > 0 && s.probability < 1) {
            const srcInfo = sourceMLMap.get(s.source);
            sources.push({
              sourceId: srcInfo?.sourceId ?? s.source,
              weight: srcInfo?.weight ?? 0.5,
              brier30d: srcInfo?.brier30d ?? 0.25,
              clv30d: srcInfo?.clv30d ?? 0,
              calibrationA: srcInfo?.calibrationA ?? 1,
              calibrationB: srcInfo?.calibrationB ?? 0,
              rawProb: s.probability,
            });
          }
        }
      } catch { /* skip */ }

      const marketClv = m.leagueId
        ? (marketClvMap.get(`${p.market}|${m.leagueId}`) ?? null)
        : null;

      legInputs.push({
        predictionId: p.id,
        matchId: m.id,
        matchLabel: `${m.homeTeam} v ${m.awayTeam}`,
        market: p.market,
        selection: p.selection,
        odds: p.bookOdds ?? p.fairOdds,
        probability: p.probability,
        confidence: p.confidence,
        consensusSources: p.consensusSources ?? 0,
        disagreement: p.disagreement,
        sources,
        leagueId: m.leagueId ?? null,
        marketLeagueClv: marketClv,
        h2hJson: m.h2hJson ?? null,
        actualOutcome: p.correct === true,
        bookOdds: p.bookOdds ?? null,
        label: `${m.homeTeam} v ${m.awayTeam} · ${p.market} ${p.selection}`,
      });
    }
  }

  console.log(`        → ${legInputs.length} legs ready for grid search`);
  console.log();

  if (legInputs.length < 50) {
    console.warn(
      `  ⚠ Only ${legInputs.length} legs — backtest results will be noisy.` +
      ` Recommend at least 200 settled predictions for stable weight estimates.`
    );
    console.log();
  }

  // ── 4. Grid search ─────────────────────────────────────────────────────
  console.log("  [4/4] Grid-searching weight combinations...");
  const combos = generateWeightGrid();
  console.log(`        → ${combos.length} valid weight combinations to evaluate`);
  console.log();

  const results: ComboResult[] = [];
  let progress = 0;
  for (const combo of combos) {
    progress++;
    if (progress % 20 === 0) {
      process.stdout.write(`\r        Progress: ${progress}/${combos.length} combos evaluated   `);
    }

    // Compute reliability + adjustedProb for every leg under this combo
    const evaluations: LegEvaluation[] = legInputs.map((leg) => {
      const ml = computeLegMLScoreWithWeights(leg, combo);
      return {
        predictionId: leg.predictionId,
        matchLabel: leg.label,
        market: leg.market,
        selection: leg.selection,
        bookOdds: leg.bookOdds,
        actualOutcome: leg.actualOutcome,
        reliability: ml.reliability,
        adjustedProb: ml.adjustedProb,
      };
    });

    // ── Metric 1: Brier score ──
    const brier = brierScore(
      evaluations.map((e) => ({ pred: e.adjustedProb, actual: e.actualOutcome ? 1 : 0 }))
    );

    // ── Metric 2: Top-decile hit rate ──
    const sortedByRel = [...evaluations].sort((a, b) => b.reliability - a.reliability);
    const decileSize = Math.max(1, Math.floor(sortedByRel.length / 10));
    const topDecile = sortedByRel.slice(0, decileSize);
    const topDecileHitRate = topDecile.filter((e) => e.actualOutcome).length / topDecile.length;
    const bottomDecile = sortedByRel.slice(-decileSize);
    const bottomDecileLossRate = bottomDecile.filter((e) => !e.actualOutcome).length / bottomDecile.length;

    // ── Metric 3: Safest-tier ROI (reliability ≥ 0.70) ──
    const safestBets = evaluations.filter((e) => e.reliability >= 0.70 && e.bookOdds && e.bookOdds > 1);
    let safestPnl = 0;
    for (const bet of safestBets) {
      safestPnl += bet.actualOutcome ? (bet.bookOdds! - 1) : -1;
    }
    const safestRoi = safestBets.length > 0 ? safestPnl / safestBets.length : 0;

    results.push({
      combo,
      brier,
      topDecileHitRate,
      bottomDecileLossRate,
      safestRoi,
      safestBetsCount: safestBets.length,
      compositeScore: 0, // filled in after z-scores
    });
  }
  process.stdout.write("\r" + " ".repeat(80) + "\r");

  // ── Composite score: weighted z-score sum ──────────────────────────────
  const brierMean = mean(results.map((r) => r.brier));
  const brierStd = std(results.map((r) => r.brier), brierMean);
  const topMean = mean(results.map((r) => r.topDecileHitRate));
  const topStd = std(results.map((r) => r.topDecileHitRate), topMean);
  const roiMean = mean(results.map((r) => r.safestRoi));
  const roiStd = std(results.map((r) => r.safestRoi), roiMean);
  const botMean = mean(results.map((r) => r.bottomDecileLossRate));
  const botStd = std(results.map((r) => r.bottomDecileLossRate), botMean);

  for (const r of results) {
    const zBrier = brierStd > 0 ? (r.brier - brierMean) / brierStd : 0;
    const zTop = topStd > 0 ? (r.topDecileHitRate - topMean) / topStd : 0;
    const zRoi = roiStd > 0 ? (r.safestRoi - roiMean) / roiStd : 0;
    const zBot = botStd > 0 ? (r.bottomDecileLossRate - botMean) / botStd : 0;
    // Lower brier is better → invert sign
    r.compositeScore = (-zBrier * 1.0) + (zTop * 0.5) + (zRoi * 0.5) + (zBot * 0.3);
  }

  results.sort((a, b) => b.compositeScore - a.compositeScore);

  // ── Print results ──────────────────────────────────────────────────────
  console.log("═".repeat(78));
  console.log("  TOP 10 WEIGHT COMBINATIONS");
  console.log("═".repeat(78));
  console.log(
    "  #   prob  cohsn mktClv srcQ  tier  h2h   │ Brier   Top%  Bot%L  ROI%   Bets"
  );
  console.log("  " + "─".repeat(76));

  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    console.log(
      `  ${(i + 1).toString().padStart(2)}  ` +
      `${r.combo.prob.toFixed(2)}  ${r.combo.sourceCohesion.toFixed(2)}  ` +
      `${r.combo.marketClv.toFixed(2)}   ${r.combo.sourceQuality.toFixed(2)}  ` +
      `${r.combo.tierHistory.toFixed(2)}  ${r.combo.h2h.toFixed(2)}  │ ` +
      `${r.brier.toFixed(4)}  ${pct(r.topDecileHitRate)}  ${pct(r.bottomDecileLossRate)}  ` +
      `${pct(r.safestRoi)}  ${r.safestBetsCount}`
    );
  }

  console.log();
  console.log("═".repeat(78));
  console.log("  CURRENT PRODUCTION WEIGHTS (for comparison)");
  console.log("═".repeat(78));
  const current: WeightCombo = {
    prob: 0.25, sourceCohesion: 0.13, marketClv: 0.10,
    sourceQuality: 0.10, tierHistory: 0.05, h2h: 0.37,
  };
  const currentResult = results.find(
    (r) => r.combo.prob === current.prob &&
           r.combo.sourceCohesion === current.sourceCohesion &&
           r.combo.marketClv === current.marketClv &&
           r.combo.sourceQuality === current.sourceQuality &&
           r.combo.tierHistory === current.tierHistory &&
           r.combo.h2h === current.h2h
  ) ?? results[0]; // fallback if exact match not in grid
  const currentRank = results.indexOf(currentResult) + 1;
  console.log(`  Rank: ${currentRank} of ${results.length}`);
  console.log(`  Brier:           ${currentResult.brier.toFixed(4)}`);
  console.log(`  Top-decile hit:  ${pct(currentResult.topDecileHitRate)}`);
  console.log(`  Bot-decile loss: ${pct(currentResult.bottomDecileLossRate)}`);
  console.log(`  Safest ROI:      ${pct(currentResult.safestRoi)} (${currentResult.safestBetsCount} bets)`);
  console.log();

  console.log("═".repeat(78));
  console.log("  RECOMMENDED ACTION");
  console.log("═".repeat(78));
  const best = results[0];
  console.log(`  Best combo: prob=${best.combo.prob.toFixed(2)} sourceCohesion=${best.combo.sourceCohesion.toFixed(2)} ` +
              `marketClv=${best.combo.marketClv.toFixed(2)} sourceQuality=${best.combo.sourceQuality.toFixed(2)} ` +
              `tierHistory=${best.combo.tierHistory.toFixed(2)} h2h=${best.combo.h2h.toFixed(2)}`);
  console.log(`  Improvement over current: compositeScore +${(best.compositeScore - currentResult.compositeScore).toFixed(3)} z-score`);
  console.log();
  console.log("  To adopt: update ML_WEIGHTS in src/lib/learning/parlay-ml.ts");
  console.log();

  await db.$disconnect();
}

// ──────────────────────────────────────────────────────────────────────────────
// Weight grid generator
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Generate a grid of valid weight combinations.
 *
 * For tractability, we sample each of the 6 weights from a discrete set and
 * keep only combinations that sum to 1.0 (within 0.01 tolerance). To keep the
 * grid manageable (~hundreds, not thousands of combos), we sample:
 *   - h2h: 5 values (0.25, 0.30, 0.35, 0.40, 0.45) — always large per user directive
 *   - prob: 4 values (0.15, 0.20, 0.25, 0.30)
 *   - sourceCohesion: 3 values (0.08, 0.13, 0.18)
 *   - marketClv: 3 values (0.05, 0.10, 0.15)
 *   - sourceQuality: 3 values (0.05, 0.10, 0.15)
 *   - tierHistory: derived as 1 - sum(others), kept if in [0.02, 0.10]
 *
 * Total: 5 × 4 × 3 × 3 × 3 = 540 raw combos, then filtered to those where
 * derived tierHistory is in [0.02, 0.10]. Typically ~200-300 valid combos.
 */
function generateWeightGrid(): WeightCombo[] {
  const combos: WeightCombo[] = [];
  const h2hValues = [0.25, 0.30, 0.35, 0.40, 0.45];
  const probValues = [0.15, 0.20, 0.25, 0.30];
  const cohesionValues = [0.08, 0.13, 0.18];
  const mktClvValues = [0.05, 0.10, 0.15];
  const srcQValues = [0.05, 0.10, 0.15];

  for (const h2h of h2hValues) {
    for (const prob of probValues) {
      for (const cohesion of cohesionValues) {
        for (const mktClv of mktClvValues) {
          for (const srcQ of srcQValues) {
            const tierHistory = 1 - (h2h + prob + cohesion + mktClv + srcQ);
            if (tierHistory < 0.02 || tierHistory > 0.10) continue;
            const combo: WeightCombo = {
              prob, sourceCohesion: cohesion, marketClv: mktClv,
              sourceQuality: srcQ, tierHistory, h2h,
            };
            if (isValidWeightVector(combo, 0.001)) {
              combos.push(combo);
            }
          }
        }
      }
    }
  }
  return combos;
}

// ──────────────────────────────────────────────────────────────────────────────
// Stats helpers
// ──────────────────────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[], mu: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function pct(x: number): string {
  const sign = x >= 0 ? "+" : "";
  return `${sign}${(x * 100).toFixed(1)}%`;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 60);
  return d.toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────────────────────
// Run
// ──────────────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
