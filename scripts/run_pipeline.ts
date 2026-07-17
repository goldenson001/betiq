/**
 * Run the full pipeline for today (Brussels timezone):
 *   1. Scrape ESPN fixtures + attach prediction-site consensus
 *   2. Aggregate raw predictions into compound market predictions
 *   3. Build & persist parlays (safest / medium_risk / high_risk / mega_odds)
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

  console.log(`[pipeline] Phase 4: building parlays (safest / medium / high / mega)...`);
  const par = await buildAndPersistParlays(today);
  console.log(
    `[pipeline] Parlays -> safest: ${par.safest?.legs.length ?? 0} legs / ` +
    `medium: ${par.mediumRisk?.legs.length ?? 0} legs / ` +
    `high: ${par.highRisk?.legs.length ?? 0} legs / ` +
    `mega: ${par.megaOdds?.legs.length ?? 0} legs`
  );

  console.log(`[pipeline] Done.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
