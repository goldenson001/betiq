/**
 * WindDrawWin scraper — today's predictions.
 * Returns EMPTY result when the site is unreachable. ESPN is canonical for fixtures.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "windrawwin";
const SOURCE_URL = "https://www.windrawwin.com/predictions/today/";

function parseWdwHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];
  // WindDrawWin rows: <tr> with td cells containing time, teams, league, prediction codes
  const rows = html.match(/<tr[^>]*class="[^"]*(?:pred|ft|match)[^"]*"[\s\S]*?<\/tr>/gi) ?? [];
  for (const rowHtml of rows) {
    const cells = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => stripHtml(c).trim());
    if (cells.length < 5) continue;

    // Try to find a time cell
    const timeCell = cells.find((c) => /^\d{1,2}:\d{2}$/.test(c));
    if (!timeCell) continue;

    // Teams usually in format "TeamA vs TeamB" in one cell, or two cells
    let homeRaw = "";
    let awayRaw = "";
    const vsCell = cells.find((c) => /\sv\s/i.test(c) || /\svs?\s/i.test(c));
    if (vsCell) {
      const parts = vsCell.split(/\svs?\s/i);
      homeRaw = parts[0]?.trim() ?? "";
      awayRaw = parts[1]?.trim() ?? "";
    } else {
      // Look for two consecutive non-numeric, non-prediction cells
      for (let i = 0; i < cells.length - 1; i++) {
        if (cells[i].length > 2 && cells[i + 1].length > 2 &&
            !/^\d/.test(cells[i]) && !/^\d/.test(cells[i + 1])) {
          homeRaw = cells[i];
          awayRaw = cells[i + 1];
          break;
        }
      }
    }
    if (!homeRaw || !awayRaw) continue;

    // League
    const leagueMatch = rowHtml.match(/data-competition="([^"]+)"/i) ?? rowHtml.match(/data-league="([^"]+)"/i);
    const leagueRaw = leagueMatch?.[1] ?? "Unknown";
    const home = normalizeTeam(homeRaw);
    const away = normalizeTeam(awayRaw);
    const { name: leagueName, country } = normalizeLeague(leagueRaw);

    const utc = brusselsTimeToUtc(targetDate, timeCell);
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

    // WDWin prediction codes often: 1, X, 2 for result + score + O/U
    const pick1x2 = (cells.find((c) => /^(1|X|2)$/i.test(c)) as "1" | "X" | "2" | undefined) ?? undefined;
    const correctScore = cells.find((c) => /^\d-\d$/.test(c)) ?? undefined;
    const ou25 = (cells.find((c) => /^(over|under)$/i.test(c)) as "over" | "under" | undefined) ?? undefined;
    const btts = (cells.find((c) => /^(yes|no)$/i.test(c)) as "yes" | "no" | undefined) ?? undefined;

    const prediction: RawSourcePrediction = {
      "1x2": pick1x2,
      correctScore,
      ou25,
      btts,
      raw: { source: SOURCE_NAME, cells },
    };

    results.push({ match, prediction });
  }
  return results;
}

export async function scrapeWindrawwin(targetDate?: string): Promise<ScrapeResult> {
  const dateStr = targetDate ?? brusselsDateString();
  const startedAt = new Date();
  try {
    const res = await fetchWithRotation(SOURCE_URL, { timeoutMs: 15000, retries: 1 });
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
    const matches = parseWdwHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from WindDrawWin HTML",
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
