/**
 * Scheduler
 * ─────────
 * Two mechanisms:
 *   1. Long-running setInterval that fires at the next 00:00 Brussels, then
 *      every 24h. Used when the app is the only process running.
 *   2. On-boot check that runs the pipeline if today's pipeline hasn't run
 *      yet (so a restart at any time will backfill today's data).
 */

import { runDailyPipeline } from "./pipeline";
import { brusselsDateString, nextMidnightBrussels } from "@/lib/time/brussels";
import { db } from "@/lib/db";

const PIPELINE_KEY = "last_pipeline_run_date";

let timer: NodeJS.Timeout | null = null;
let booted = false;

async function getLastRunDate(): Promise<string | null> {
  const row = await db.modelState.findUnique({ where: { key: PIPELINE_KEY } });
  return row ? String(row.value) : null;
}

async function setLastRunDate(date: string): Promise<void> {
  // We store the date as a numeric representation so it fits the Float field.
  const numeric = parseFloat(date.replace(/-/g, ""));
  await db.modelState.upsert({
    where: { key: PIPELINE_KEY },
    create: { key: PIPELINE_KEY, value: numeric, notes: date },
    update: { value: numeric, notes: date },
  });
}

async function runPipelineIfNeeded(targetDate?: string): Promise<void> {
  const dateStr = targetDate ?? brusselsDateString();
  const last = await getLastRunDate();
  if (last === dateStr) return; // already ran today
  try {
    await runDailyPipeline(dateStr);
    await setLastRunDate(dateStr);
    console.log(`[scheduler] Pipeline completed for ${dateStr}`);
  } catch (err) {
    console.error("[scheduler] Pipeline failed:", err);
  }
}

export function startScheduler(): void {
  if (booted) return;
  booted = true;

  // On boot, run pipeline if today's hasn't run
  runPipelineIfNeeded().catch((err) =>
    console.error("[scheduler] Boot pipeline error:", err)
  );

  // Schedule next 00:00 Brussels
  const nextMidnight = nextMidnightBrussels();
  const msUntilMidnight = nextMidnight.getTime() - Date.now();
  setTimeout(() => {
    runPipelineIfNeeded().catch((err) =>
      console.error("[scheduler] Midnight pipeline error:", err)
    );
    // Then set up a recurring 24h timer
    timer = setInterval(() => {
      runPipelineIfNeeded().catch((err) =>
        console.error("[scheduler] Interval pipeline error:", err)
      );
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  console.log(
    `[scheduler] Next pipeline run scheduled for ${nextMidnight.toISOString()} (${msUntilMidnight / 1000 / 60} min from now)`
  );
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  booted = false;
}
