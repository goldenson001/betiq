/**
 * Daily pipeline — orchestrates the full morning run:
 *   1. Run feedback loop for yesterday's (and earlier) unprocessed matches
 *   2. Scrape today's predictions from all sources
 *   3. Generate compound predictions for all today's matches
 *   4. Build parlays (best, safe, value)
 *   5. Log completion
 *
 * Idempotent: safe to call multiple times per day.
 */

import { db } from "@/lib/db";
import { runAllScrapers } from "@/lib/scrapers/orchestrator";
import { generatePredictionsForDate } from "@/lib/prediction/engine";
import { buildAndPersistParlays } from "@/lib/confidence/engine";
import { runFeedbackLoopForUnprocessedDates } from "@/lib/learning/feedback";
import { brusselsDateString } from "@/lib/time/brussels";

export interface PipelineResult {
  date: string;
  feedback: { datesProcessed: string[] };
  scrape: { matchesStored: number; predictionsStored: number };
  predictions: { matches: number; predictions: number; skipped?: number };
  parlays: {
    safest: unknown | null;
    mediumRisk: unknown | null;
    highRisk: unknown | null;
    megaOdds: unknown | null;
    skipped?: boolean;
  };
  startedAt: Date;
  finishedAt: Date;
  error?: string;
}

/**
 * Run the full daily pipeline: feedback → scrape → predict → parlays.
 *
 * Idempotent by default: if predictions / parlays already exist for the date,
 * they are NOT overwritten (immutability guard). Pass `force: true` to
 * rebuild from scratch — this is admin-only and should never be used on a
 * date whose matches have already been played (it would wipe evaluation
 * results).
 */
export async function runDailyPipeline(
  targetDate?: string,
  options?: { force?: boolean }
): Promise<PipelineResult> {
  const startedAt = new Date();
  const dateStr = targetDate ?? brusselsDateString();
  const force = options?.force === true;

  try {
    // 1. Feedback loop — process any past unprocessed matches
    const feedback = await runFeedbackLoopForUnprocessedDates();

    // 2. Scrape (force flag controls whether raw predictions get overwritten)
    const scrape = await runAllScrapers(dateStr, { force });

    // 3. Generate predictions (force flag controls whether existing
    //    predictions get wiped & rebuilt)
    const predictions = await generatePredictionsForDate(dateStr, { force });

    // 4. Build parlays (force flag controls whether existing parlays get
    //    wiped & rebuilt)
    const parlays = await buildAndPersistParlays(dateStr, { force });

    return {
      date: dateStr,
      feedback,
      scrape,
      predictions,
      parlays,
      startedAt,
      finishedAt: new Date(),
    };
  } catch (err) {
    return {
      date: dateStr,
      feedback: { datesProcessed: [] },
      scrape: { matchesStored: 0, predictionsStored: 0 },
      predictions: { matches: 0, predictions: 0 },
      parlays: { safest: null, mediumRisk: null, highRisk: null, megaOdds: null },
      startedAt,
      finishedAt: new Date(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
