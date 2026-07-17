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
  predictions: { matches: number; predictions: number };
  parlays: {
    safest: unknown | null;
    mediumRisk: unknown | null;
    highRisk: unknown | null;
    megaOdds: unknown | null;
  };
  startedAt: Date;
  finishedAt: Date;
  error?: string;
}

export async function runDailyPipeline(targetDate?: string): Promise<PipelineResult> {
  const startedAt = new Date();
  const dateStr = targetDate ?? brusselsDateString();

  try {
    // 1. Feedback loop — process any past unprocessed matches
    const feedback = await runFeedbackLoopForUnprocessedDates();

    // 2. Scrape
    const scrape = await runAllScrapers(dateStr);

    // 3. Generate predictions
    const predictions = await generatePredictionsForDate(dateStr);

    // 4. Build parlays
    const parlays = await buildAndPersistParlays(dateStr);

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
