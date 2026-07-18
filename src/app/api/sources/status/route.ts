/**
 * GET /api/sources/status
 * Returns health status for all configured prediction sources.
 *
 * For each source, returns:
 *   - name, displayName, url, weight
 *   - lastScrapedAt (when the scraper last ran)
 *   - lastStatus ('success' | 'failed' | 'never')
 *   - lastError (truncated error message, if any)
 *   - matchesFound (last scrape's match count)
 *   - recentSuccessRate (last 7 scrape logs: success / total)
 *
 * Also returns aggregate:
 *   - totalSources
 *   - activeSources (those with a successful scrape in the last 7 days)
 *   - healthySources (recentSuccessRate >= 0.5)
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sources = await db.source.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        url: true,
        weight: true,
        lastScrapedAt: true,
      },
    });

    // For each source, fetch the last 7 scrape logs to compute success rate
    const sourcesWithHealth = await Promise.all(
      sources.map(async (s) => {
        const recentLogs = await db.scrapeLog.findMany({
          where: { source: s.name },
          orderBy: { startedAt: "desc" },
          take: 7,
          select: {
            status: true,
            matchesFound: true,
            error: true,
            startedAt: true,
          },
        });

        const lastLog = recentLogs[0];
        const successCount = recentLogs.filter((l) => l.status === "success").length;
        const recentSuccessRate = recentLogs.length > 0 ? successCount / recentLogs.length : 0;

        // Active = at least one successful scrape in the last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const lastSuccessLog = recentLogs.find((l) => l.status === "success" && l.startedAt >= sevenDaysAgo);
        const isActive = !!lastSuccessLog;
        const isHealthy = recentSuccessRate >= 0.5;

        return {
          name: s.name,
          displayName: s.displayName,
          url: s.url,
          weight: s.weight,
          lastScrapedAt: s.lastScrapedAt,
          lastStatus: lastLog?.status ?? "never",
          lastError: lastLog?.error ? lastLog.error.slice(0, 200) : null,
          lastMatchesFound: lastLog?.matchesFound ?? 0,
          recentSuccessRate: Math.round(recentSuccessRate * 100),
          recentSamples: recentLogs.length,
          isActive,
          isHealthy,
        };
      })
    );

    const activeSources = sourcesWithHealth.filter((s) => s.isActive).length;
    const healthySources = sourcesWithHealth.filter((s) => s.isHealthy).length;

    return NextResponse.json({
      ok: true,
      totalSources: sources.length,
      activeSources,
      healthySources,
      sources: sourcesWithHealth,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
}
