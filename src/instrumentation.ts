/**
 * Next.js instrumentation hook — runs once on server boot.
 *
 * On long-running hosts (Docker, bare metal, `next start`) it starts the
 * in-process scheduler that runs the daily pipeline at 00:00 Brussels.
 *
 * On Vercel (serverless) the in-process scheduler is SKIPPED because:
 *   1. Serverless functions freeze between requests — setTimeout/setInterval
 *      won't fire reliably.
 *   2. Cold starts would otherwise trigger the full pipeline on every
 *      request, exceeding the function timeout (10s on Hobby plan).
 *
 * Vercel's cron system (configured in vercel.json) handles the daily run
 * by hitting GET /api/trigger?phase=all at 22:00 UTC (== 00:00 Brussels).
 */

export async function register(): Promise<void> {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Skip on Vercel — cron in vercel.json handles scheduling
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    console.log("[instrumentation] Running on Vercel — in-process scheduler skipped (cron handles it)");
    return;
  }

  if (process.env.DISABLE_SCHEDULER === "true") {
    console.log("[instrumentation] Scheduler disabled by env");
    return;
  }
  // Dynamically import to avoid loading scheduler in edge runtime
  const { startScheduler } = await import("@/lib/scheduler/scheduler");
  startScheduler();
}
