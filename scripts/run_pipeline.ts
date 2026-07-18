/**
 * Run the full pipeline for today (Brussels timezone):
 *   1. Scrape ESPN fixtures + attach prediction-site consensus
 *   2. Aggregate raw predictions into compound market predictions
 *   3. Build & persist parlays (8 tiers: safest / medium / high / mega /
 *      odds_3_a / odds_3_b / odds_5_a / odds_5_b)
 *
 * Usage:
 *   npx tsx scripts/run_pipeline.ts            # today (Brussels)
 *   npx tsx scripts/run_pipeline.ts 2026-07-17 # explicit date
 */

import { runAllScrapers } from "@/lib/scrapers/orchestrator";
import { generatePredictionsForDate } from "@/lib/prediction/engine";
import { buildAndPersistParlays } from "@/lib/confidence/engine";
import { brusselsDateString } from "@/lib/time/brussels";

async function main() {
  const dateArg = process.argv[2];
  const today = dateArg || brusselsDateString();
  console.log(`[pipeline] Brussels date: ${today}`);

  console.log(`[pipeline] Phase 1+2: scraping ESPN + prediction sites...`);
  const sr = await runAllScrapers(today);
  console.log(
    `[pipeline] Stored ${sr.matchesStored} matches, ${sr.predictionsStored} raw predictions`
  );
  for (const r of sr.results) {
    const status = r.error ? `[error: ${r.error}]` : `[ok]`;
    console.log(`[pipeline]   ${r.source}: ${r.matches.length} matches ${status}`);
  }

  console.log(`[pipeline] Phase 3: aggregating compound predictions...`);
  const p = await generatePredictionsForDate(today);
  console.log(
    `[pipeline] Generated ${p.predictions} compound predictions across ${p.matches} matches`
  );

  console.log(`[pipeline] Phase 4: building 8 parlay tiers...`);
  const par = await buildAndPersistParlays(today);
  const fmt = (name: string, cand: { legs: unknown[] } | null) =>
    `${name}: ${cand?.legs.length ?? 0}`;
  console.log(
    `[pipeline] Parlays -> ${fmt("safest", par.safest)} / ${fmt("medium", par.mediumRisk)} / ` +
    `${fmt("high", par.highRisk)} / ${fmt("mega", par.megaOdds)} / ` +
    `${fmt("odds3A", par.odds3A)} / ${fmt("odds3B", par.odds3B)} / ` +
    `${fmt("odds5A", par.odds5A)} / ${fmt("odds5B", par.odds5B)}`
  );

  console.log(`[pipeline] Done.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
