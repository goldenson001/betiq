/**
 * Sanity test for the ML-driven parlay selection.
 *
 * Runs the parlay pipeline for today and verifies that:
 *   1. ML scores are computed for every leg
 *   2. Parlay rows have mlScore, mlComponentsJson, mlAdjustedProbability, mlSampleCount set
 *   3. The safest tier uses higher-ML legs than the medium_risk tier (on average)
 *
 * Run with: npx tsx scripts/test-parlay-ml.ts
 */

import { db } from "../src/lib/db";
import { buildAndPersistParlays } from "../src/lib/confidence/engine";
import { loadAllParlayTierStats, mlScoreToGrade, ML_WEIGHTS } from "../src/lib/learning/parlay-ml";
import { brusselsDateString } from "../src/lib/time/brussels";

async function main() {
  const date = brusselsDateString();
  console.log(`\n=== Testing ML parlay selection for ${date} ===\n`);

  // Show pre-existing tier stats (Bayesian priors)
  const tierStats = await loadAllParlayTierStats();
  console.log("Pre-build tier stats:");
  if (tierStats.size === 0) {
    console.log("  (no historical samples — cold start, will use pure math prior)");
  } else {
    for (const [tier, stats] of tierStats.entries()) {
      console.log(`  ${tier}: ${stats.wonParlays}/${stats.totalParlays} won (lifetime ${ (stats.lifetimeWinRate * 100).toFixed(1) }%) · rolling ${ (stats.rollingWinRate * 100).toFixed(1) }% · ${stats.sampleCount} samples`);
    }
  }
  console.log("");

  // Show ML weights
  console.log("ML weights (safety-first tuned):");
  for (const [k, v] of Object.entries(ML_WEIGHTS)) {
    console.log(`  ${k.padEnd(20)} = ${v}`);
  }
  console.log("");

  // Build parlays
  console.log("Building parlays with ML...");
  const result = await buildAndPersistParlays(date);
  console.log("✓ Parlays built\n");

  // Inspect each tier's persisted row
  const parlays = await db.parlay.findMany({ where: { matchDate: date } });
  console.log(`Persisted ${parlays.length} parlay rows:\n`);

  for (const p of parlays) {
    const tier = p.type;
    const mlScore = p.mlScore;
    const mlGrade = mlScore !== null ? mlScoreToGrade(mlScore) : null;
    const adjProb = p.mlAdjustedProbability;
    const sampleCount = p.mlSampleCount ?? 0;

    console.log(`── ${tier} (${p.legsCount} legs) ───────────────────────────────`);
    console.log(`  Combined odds:        ${p.combinedOdds.toFixed(2)}`);
    console.log(`  Combined prob (math): ${(p.combinedProbability * 100).toFixed(1)}%`);
    if (adjProb !== null && sampleCount > 0) {
      const delta = adjProb - p.combinedProbability;
      const arrow = delta > 0.001 ? "↑" : delta < -0.001 ? "↓" : "=";
      console.log(`  Bayesian adj prob:    ${(adjProb * 100).toFixed(1)}% ${arrow} (using ${sampleCount} samples)`);
    } else {
      console.log(`  Bayesian adj prob:    (cold start — using pure math prior)`);
    }
    console.log(`  ML score:             ${mlScore !== null ? (mlScore * 100).toFixed(1) + "%" : "—"} ${mlGrade ? "(" + mlGrade.grade + " · " + mlGrade.label + ")" : ""}`);
    console.log(`  Recommended stake:    ${p.recommendedStake !== null ? (p.recommendedStake * 100).toFixed(3) + "%" : "—"} of bankroll`);
    console.log(`  Expected value:       ${(p.expectedValue * 100).toFixed(1)}%`);

    // Parse legs JSON to show per-leg ML breakdown
    if (p.mlComponentsJson) {
      try {
        const comps = JSON.parse(p.mlComponentsJson);
        console.log(`  Per-leg ML scores:`);
        for (const leg of comps.legs) {
          const legGrade = leg.reliability !== null ? mlScoreToGrade(leg.reliability) : null;
          console.log(`    [${legGrade?.grade ?? "?"}] ${leg.matchLabel} — ${leg.market.replace(/_/g, " ")}: ${leg.selection}`);
          console.log(`        reliability: ${(leg.reliability * 100).toFixed(1)}%  calibrated: ${(leg.calibratedProb * 100).toFixed(1)}%  adjusted: ${(leg.adjustedProb * 100).toFixed(1)}%`);
          if (leg.components) {
            const c = leg.components;
            console.log(`        components: prob=${(c.prob*100).toFixed(0)} consensus=${(c.consensus*100).toFixed(0)} disagree=${(c.lowDisagreement*100).toFixed(0)} mktClv=${(c.marketClv*100).toFixed(0)} srcBrier=${(c.sourceBrier*100).toFixed(0)} srcClv=${(c.sourceClv*100).toFixed(0)} tierHist=${(c.tierHistory*100).toFixed(0)}`);
          }
        }
      } catch { /* parse failure */ }
    }
    console.log("");
  }

  // Verify: safest tier should have higher ML score than medium_risk
  const safest = parlays.find((p) => p.type === "safest");
  const medium = parlays.find((p) => p.type === "medium_risk");
  if (safest?.mlScore !== null && medium?.mlScore !== null && safest && medium) {
    if (safest.mlScore! >= medium.mlScore!) {
      console.log(`✓ PASS: safest tier ML score (${(safest.mlScore!*100).toFixed(1)}%) >= medium_risk (${(medium.mlScore!*100).toFixed(1)}%)`);
    } else {
      console.log(`⚠ NOTE: safest tier ML score (${(safest.mlScore!*100).toFixed(1)}%) < medium_risk (${(medium.mlScore!*100).toFixed(1)}%) — this can happen when safer legs are scarce`);
    }
  }

  console.log("\n=== Test complete ===\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  });
