/**
 * Soccerstats scraper — heavy stats-based predictions.
 *
 * Soccerstats.com publishes per-match pages with team form, league standings,
 * H2H records, and prediction indicators (1X2 lean, BTTS%, O/U%). The main
 * "today's matches" listing is HTML but heavier / slower to load.
 *
 * We extract whatever picks we can identify; ESPN remains the canonical
 * fixture source.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "soccerstats";
const SOURCE_URL = "https://www.soccerstats.com/matches.asp?league=0";

function parseSoccerstatsHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];

  // Soccerstats uses <tr> rows with onmouseover attributes for matches
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];

  for (const rowHtml of rowMatches) {
    // Look for match link with team names
    const linkMatch = rowHtml.match(/<a[^>]*href="[^"]*match\.asp\?id=\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const teamsCell = stripHtml(linkMatch[1]).trim();
    if (!teamsCell || teamsCell.length < 4) continue;

    // Try to split team names — Soccerstats uses "Home v Away" or "Home - Away"
    let homeRaw = "";
    let awayRaw = "";
    if (teamsCell.includes(" v ")) {
      [homeRaw, awayRaw] = teamsCell.split(" v ").map((s) => s.trim());
    } else if (teamsCell.includes(" vs ")) {
      [homeRaw, awayRaw] = teamsCell.split(" vs ").map((s) => s.trim());
    } else if (teamsCell.includes(" - ")) {
      [homeRaw, awayRaw] = teamsCell.split(" - ").map((s) => s.trim());
    } else {
      continue;
    }
    if (!homeRaw || !awayRaw || homeRaw.length < 2 || awayRaw.length < 2) continue;

    const cells = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => stripHtml(c).trim());
    const timeMatch = cells.find((c) => /^\d{1,2}:\d{2}$/.test(c));
    const timeStr = timeMatch ?? "12:00";

    // Soccerstats doesn't expose clear pick cells; we extract probabilities
    // when the row contains percentage values like "Home win: 55%"
    const pHomeMatch = rowHtml.match(/home[^<]*?(\d{1,3})%/i);
    const pDrawMatch = rowHtml.match(/draw[^<]*?(\d{1,3})%/i);
    const pAwayMatch = rowHtml.match(/away[^<]*?(\d{1,3})%/i);
    const pHome = pHomeMatch ? parseInt(pHomeMatch[1], 10) / 100 : undefined;
    const pDraw = pDrawMatch ? parseInt(pDrawMatch[1], 10) / 100 : undefined;
    const pAway = pAwayMatch ? parseInt(pAwayMatch[1], 10) / 100 : undefined;

    let pick1x2: "1" | "X" | "2" | undefined;
    if (pHome !== undefined && pDraw !== undefined && pAway !== undefined) {
      if (pHome >= pDraw && pHome >= pAway) pick1x2 = "1";
      else if (pAway >= pDraw) pick1x2 = "2";
      else pick1x2 = "X";
    }

    // BTTS% extraction
    const bttsPctMatch = rowHtml.match(/btts[^<]*?(\d{1,3})%/i);
    let btts: "yes" | "no" | undefined;
    if (bttsPctMatch) {
      const pct = parseInt(bttsPctMatch[1], 10) / 100;
      btts = pct >= 0.5 ? "yes" : "no";
    }

    // O/U 2.5%
    const ouPctMatch = rowHtml.match(/over\s*2\.5[^<]*?(\d{1,3})%/i);
    let ou25: "over" | "under" | undefined;
    if (ouPctMatch) {
      const pct = parseInt(ouPctMatch[1], 10) / 100;
      ou25 = pct >= 0.5 ? "over" : "under";
    }

    const leagueRaw = cells[1] ?? "Unknown";
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
      btts,
      ou25,
      probabilities: (pHome !== undefined || pDraw !== undefined || pAway !== undefined)
        ? { home: pHome, draw: pDraw, away: pAway }
        : undefined,
      raw: { source: SOURCE_NAME, homeRaw, awayRaw, leagueRaw, pHome, pDraw, pAway, bttsPct: bttsPctMatch?.[1], ouPct: ouPctMatch?.[1] },
    };

    results.push({ match, prediction });
  }

  return results;
}

export async function scrapeSoccerstats(targetDate?: string): Promise<ScrapeResult> {
  const dateStr = targetDate ?? brusselsDateString();
  const startedAt = new Date();
  try {
    const res = await fetchWithRotation(SOURCE_URL, { timeoutMs: 20000, retries: 1, minDelayMs: 2000 });
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
    const matches = parseSoccerstatsHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from Soccerstats HTML",
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
