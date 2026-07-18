#!/usr/bin/env bun
/**
 * Backtest CLI — runs a historical backtest from the command line.
 *
 * Usage:
 *   bun run scripts/backtest.ts <startDate> <endDate>
 *   bun run scripts/backtest.ts 2026-06-01 2026-06-30
 *
 * Outputs a JSON report to stdout, and a human-readable summary to stderr.
 * Saves the full JSON to /home/z/my-project/download/backtest-<range>.json
 * for download.
 */

import { runBacktest, getBacktestRange } from "../src/lib/learning/backtest";
import { db } from "../src/lib/db";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const args = process.argv.slice(2);

  // If no args, show available range
  if (args.length === 0) {
    const range = await getBacktestRange();
    console.error("Available backtest range:");
    console.error(JSON.stringify(range, null, 2));
    console.error("\nUsage: bun run scripts/backtest.ts <startDate> <endDate>");
    console.error("Example: bun run scripts/backtest.ts 2026-06-01 2026-06-30");
    process.exit(0);
  }

  if (args.length < 2) {
    console.error("Usage: bun run scripts/backtest.ts <startDate> <endDate>");
    process.exit(1);
  }

  const [startDate, endDate] = args;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(startDate) || !dateRe.test(endDate)) {
    console.error("Dates must be in YYYY-MM-DD format");
    process.exit(1);
  }

  console.error(`Running backtest from ${startDate} to ${endDate}...`);
  const startedAt = Date.now();
  const result = await runBacktest(startDate, endDate);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // Save full JSON to download directory
  const downloadDir = "/home/z/my-project/download";
  try { mkdirSync(downloadDir, { recursive: true }); } catch { /* exists */ }
  const filename = `backtest-${startDate}-to-${endDate}.json`;
  const filepath = join(downloadDir, filename);
  writeFileSync(filepath, JSON.stringify(result, null, 2));

  // Human-readable summary to stderr
  console.error("\n" + "=".repeat(70));
  console.error(`BACKTEST REPORT: ${startDate} → ${endDate}  (${elapsed}s)`);
  console.error("=".repeat(70));
  console.error(`Days analyzed:        ${result.daysAnalyzed}`);
  console.error(`Total matches:        ${result.totalMatches}`);
  console.error(`Total predictions:    ${result.totalPredictions}`);
  console.error(`Total evaluated:      ${result.totalEvaluated}`);
  console.error(`Total correct:        ${result.totalCorrect}`);
  console.error(`Aggregate win rate:   ${(result.aggregateWinRate * 100).toFixed(2)}%`);
  console.error(`Aggregate Brier:      ${result.aggregateBrier.toFixed(4)} (lower=better)`);
  console.error(`Aggregate flat ROI:   ${(result.aggregateFlatRoi * 100).toFixed(2)}%`);
  console.error(`Aggregate Kelly ROI:  ${(result.aggregateKellyRoi * 100).toFixed(2)}%`);
  console.error(`Aggregate CLV:        ${result.aggregateClv !== null ? (result.aggregateClv * 100).toFixed(2) + "%" : "n/a"}`);

  console.error("\n--- Best Markets (min 3 predictions) ---");
  for (const m of result.bestMarkets) {
    console.error(`  ${(m.market + ":").padEnd(20)} ${(m.winRate * 100).toFixed(1)}%  (${m.total} preds)`);
  }

  console.error("\n--- Worst Markets (min 3 predictions) ---");
  for (const m of result.worstMarkets) {
    console.error(`  ${(m.market + ":").padEnd(20)} ${(m.winRate * 100).toFixed(1)}%  (${m.total} preds)`);
  }

  console.error("\n--- Best Sources (min 10 predictions) ---");
  for (const s of result.bestSources) {
    console.error(`  ${(s.source + ":").padEnd(20)} ${(s.accuracy * 100).toFixed(1)}%  (${s.total} preds)`);
  }

  console.error("\n--- Worst Sources (min 10 predictions) ---");
  for (const s of result.worstSources) {
    console.error(`  ${(s.source + ":").padEnd(20)} ${(s.accuracy * 100).toFixed(1)}%  (${s.total} preds)`);
  }

  console.error(`\nFull JSON report saved to: ${filepath}`);

  await db.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
