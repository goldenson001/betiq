/**
 * Run the full pipeline for today (Brussels timezone):
 *   0. Run feedback loop for any unprocessed past matches (self-heals
 *      finished-match FT scores from ESPN, evaluates settled predictions)
 *   1. Scrape ESPN fixtures + attach prediction-site consensus
 *   2. Aggregate raw predictions into compound market predictions
 *   3. Build & persist parlays (8 tiers: safest / medium / high / mega /
 *      odds_3_a / odds_3_b / odds_5_a / odds_5_b)
 *
 * Usage:
 *   npx tsx scripts/run_pipeline.ts            # today (Brussels)
 *   npx tsx scripts/run_pipeline.ts 2026-07-17 # explicit date
 *   npx tsx scripts/run_pipeline.ts --no-feedback  # skip feedback phase
 */

import { runAllScrapers } from "@/lib/scrapers/orchestrator";
import { generatePredictionsForDate } from "@/lib/prediction/engine";
import { buildAndPersistParlays } from "@/lib/confidence/engine";
import { runFeedbackLoopForUnprocessedDates } from "@/lib/learning/feedback";
import { brusselsDateString } from "@/lib/time/brussels";

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const skipFeedback = args.includes("--no-feedback");
  const today = dateArg || brusselsDateString();
  console.log(`[pipeline] Brussels date: ${today}`);

  if (!skipFeedback) {
    console.log(`[pipeline] Phase 0: running feedback loop for unprocessed dates...`);
    try {
      const fb = await runFeedbackLoopForUnprocessedDates();
      console.log(
        `[pipeline] Feedback processed ${fb.datesProcessed.length} date(s): ` +
          (fb.datesProcessed.length === 0 ? "(none pending)" : fb.datesProcessed.join(", "))
      );
    } catch (e) {
      console.warn(`[pipeline] Feedback loop failed (continuing):`, e instanceof Error ? e.message : e);
    }
  } else {
    console.log(`[pipeline] Phase 0 (feedback) skipped via --no-feedback`);
  }

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
