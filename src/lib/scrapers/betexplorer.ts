/**
 * BetExplorer scraper — odds comparison + 1X2 / O-U picks.
 *
 * BetExplorer publishes per-match pages with aggregated bookmaker odds,
 * plus a "trends" panel showing community pick percentages. The today's
 * matches listing page is HTML and reasonably scrapeable.
 *
 * ESPN remains the canonical source for fixtures; BetExplorer attaches
 * consensus picks to matches ESPN already returned.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "betexplorer";
const SOURCE_URL = "https://www.betexplorer.com/football/";

interface BxRow {
  timeStr: string;
  homeRaw: string;
  awayRaw: string;
  leagueRaw: string;
  homeOdds?: number;
  drawOdds?: number;
  awayOdds?: number;
}

/**
 * BetExplorer's today page lists matches in <tr> rows with data-odd attributes
 * for the 1X2 odds. We extract team names from the match link, league from
 * the preceding <h3> or table caption, and odds from data-odd attributes.
 */
function parseBetExplorerHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];

  // Split the page into league sections — BetExplorer groups matches by
  // competition under headings like <h3>England - Premier League</h3>.
  const sections = html.split(/<h[23][^>]*>/i).slice(1);

  for (const section of sections) {
    // Heading text is up to the first </h3>
    const headingEnd = section.indexOf("</h");
    const headingHtml = headingEnd >= 0 ? section.slice(0, headingEnd) : "";
    const leagueRaw = stripHtml(headingHtml).trim() || "Unknown";

    // Each row is <tr ...> with data-odd attrs
    const rowMatches = section.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
    for (const rowHtml of rowMatches) {
      // Look for the match link: <a href="/match/..." class="in-match">Home - Away</a>
      const linkMatch = rowHtml.match(/<a[^>]*class="[^"]*in-match[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;
      const teamsCell = stripHtml(linkMatch[1]).trim();
      if (!teamsCell.includes(" - ")) continue;
      const [homeRaw, awayRaw] = teamsCell.split(" - ").map((s) => s.trim());
      if (!homeRaw || !awayRaw || homeRaw.length < 2 || awayRaw.length < 2) continue;

      // Time — usually in a <td class="table-time">
      const timeMatch = rowHtml.match(/(\d{1,2}:\d{2})/);
      const timeStr = timeMatch?.[1] ?? "12:00";

      // Odds — data-odd attributes (1, X, 2)
      const oddsMatches = rowHtml.match(/data-odd="([\d.]+)"/gi) ?? [];
      const odds = oddsMatches.map((m) => parseFloat(m.match(/[\d.]+/)?.[0] ?? "0")).filter((n) => n > 1);
      const homeOdds = odds[0];
      const drawOdds = odds[1];
      const awayOdds = odds[2];

      // Determine 1X2 pick from lowest odds (favorite)
      let pick1x2: "1" | "X" | "2" | undefined;
      if (homeOdds && drawOdds && awayOdds) {
        if (homeOdds <= drawOdds && homeOdds <= awayOdds) pick1x2 = "1";
        else if (awayOdds <= drawOdds) pick1x2 = "2";
        else pick1x2 = "X";
      }

      // Implied probabilities (de-vigged)
      let probabilities: { home?: number; draw?: number; away?: number } | undefined;
      if (homeOdds && drawOdds && awayOdds) {
        const pHome = (1 / homeOdds);
        const pDraw = (1 / drawOdds);
        const pAway = (1 / awayOdds);
        const sum = pHome + pDraw + pAway;
        if (sum > 0) {
          probabilities = {
            home: pHome / sum,
            draw: pDraw / sum,
            away: pAway / sum,
          };
        }
      }

      const home = normalizeTeam(homeRaw);
      const away = normalizeTeam(awayRaw);
      const { name: leagueName, country } = normalizeLeague(leagueRaw);
      const utc = brusselsTimeToUtc(targetDate, timeStr);

      const match: NormalizedMatch = {
        externalId: makeExternalId(targetDate, home, away),
        matchDate: targetDate,
        kickoffUtc: utc,
        kickoffBrussels: brusselsKickoffTime(utc),
        leagueName,
        country,
        homeTeam: home,
        awayTeam: away,
      };

      const prediction: RawSourcePrediction = {
        "1x2": pick1x2,
        probabilities,
        odds: homeOdds && drawOdds && awayOdds
          ? { home: homeOdds, draw: drawOdds, away: awayOdds }
          : undefined,
        raw: { source: SOURCE_NAME, homeRaw, awayRaw, leagueRaw, homeOdds, drawOdds, awayOdds },
      };

      results.push({ match, prediction });
    }
  }

  return results;
}

export async function scrapeBetExplorer(targetDate?: string): Promise<ScrapeResult> {
  const dateStr = targetDate ?? brusselsDateString();
  const startedAt = new Date();
  try {
    const res = await fetchWithRotation(SOURCE_URL, { timeoutMs: 20000, retries: 1, minDelayMs: 1500 });
    if (!res.ok) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: `HTTP ${res.status} from ${SOURCE_URL}`,
      };
    }
    const html = await res.text();
    const matches = parseBetExplorerHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from BetExplorer HTML",
      };
    }
    return { source: SOURCE_NAME, matches, startedAt, finishedAt: new Date() };
  } catch (err) {
    return {
      source: SOURCE_NAME,
      matches: [],
      startedAt,
      finishedAt: new Date(),
      error: `fetch error: ${String(err)}`,
    };
  }
}
