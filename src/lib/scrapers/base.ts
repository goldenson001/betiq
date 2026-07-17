/**
 * Base scraper interface & shared utilities.
 *
 * NOTE: This project uses REAL fixtures from the ESPN Soccer API (no key
 * required). There are NO synthetic fallback fixtures anywhere in the system.
 * If ESPN is unreachable, the scrape returns an empty result and the dashboard
 * shows "no fixtures today" instead of fake matches.
 */

import type { ScrapedMatchData, ScrapeResult } from "@/lib/types";

export interface BaseScraper {
  readonly sourceName: string;
  readonly sourceUrl: string;
  scrape(targetDate: string): Promise<ScrapeResult>;
}

/**
 * Generic date formatter — produces "Saturday" style + day number for site URLs.
 */
export function formatUrlDate(dateStr: string): { long: string; short: string } {
  const d = new Date(dateStr + "T12:00:00Z");
  const long = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const short = dateStr.replace(/-/g, "");
  return { long, short };
}

// ──────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS — used by scrapers when computing auxiliary predictions
// (e.g. correct score from expected goals). These are deterministic math
// utilities, NOT synthetic fallback data.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Poisson PMF — used to compute correct score probability from expected goals.
 */
export function poissonPmf(k: number, lambda: number): number {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/**
 * Helper for scrapers that genuinely have no data — returns EMPTY result.
 * Use this when a scraper has exhausted all real data sources.
 */
export function emptyScrapeResult(
  sourceName: string,
  startedAt: Date,
  error: string
): ScrapeResult {
  return {
    source: sourceName,
    matches: [] as ScrapedMatchData[],
    startedAt,
    finishedAt: new Date(),
    error,
  };
}
