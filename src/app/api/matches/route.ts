/**
 * GET /api/matches
 * Returns all matches for a given Brussels date, with their predictions.
 * Query params:
 *   - date=YYYY-MM-DD (default: today Brussels)
 *   - league=string (optional filter)
 *   - market=string (optional filter — only return predictions for this market)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { brusselsDateString } from "@/lib/time/brussels";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") ?? brusselsDateString();
  const leagueFilter = searchParams.get("league");
  const marketFilter = searchParams.get("market");

  const matches = await db.match.findMany({
    where: {
      matchDate: date,
      ...(leagueFilter
        ? { league: { name: { contains: leagueFilter } } }
        : {}),
    },
    include: {
      league: true,
      predictions: marketFilter ? { where: { market: marketFilter } } : true,
      rawPredictions: { include: { source: true } },
    },
    orderBy: [{ kickoffUtc: "asc" }],
  });

  // Group by league for the frontend
  const byLeague = new Map<string, {
    league: { id: string; name: string; country: string };
    matches: typeof matches;
  }>();

  for (const m of matches) {
    const leagueName = m.league?.name ?? "Other";
    const leagueCountry = m.league?.country ?? "Unknown";
    const key = `${leagueCountry}::${leagueName}`;
    if (!byLeague.has(key)) {
      byLeague.set(key, {
        league: {
          id: m.league?.id ?? "",
          name: leagueName,
          country: leagueCountry,
        },
        matches: [],
      });
    }
    byLeague.get(key)!.matches.push(m);
  }

  return NextResponse.json({
    date,
    totalMatches: matches.length,
    leagues: Array.from(byLeague.values()).map((g) => ({
      ...g.league,
      matchCount: g.matches.length,
      matches: g.matches,
    })),
  });
}
