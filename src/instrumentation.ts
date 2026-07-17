/**
 * Next.js instrumentation hook — runs once on server boot.
 * Starts the daily Brussels-timezone scheduler that triggers the
 * scrape → predict → parlay pipeline at 00:00 CET/CEST.
 */

export async function register(): Promise<void> {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_SCHEDULER === "true") {
    console.log("[instrumentation] Scheduler disabled by env");
    return;
  }
  // Dynamically import to avoid loading scheduler in edge runtime
  const { startScheduler } = await import("@/lib/scheduler/scheduler");
  startScheduler();
}
