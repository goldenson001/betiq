/**
 * StatArea scraper — today's predictions.
 * Returns EMPTY result when the site is unreachable. ESPN is canonical for fixtures.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "statarea";
const SOURCE_URL = "https://www.statarea.com/predictions";

function parseStatareaHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  for (const rowHtml of rows) {
    const cells = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => stripHtml(c).trim());
    if (cells.length < 5) continue;

    const timeCell = cells.find((c) => /^\d{1,2}:\d{2}$/.test(c));
    if (!timeCell) continue;

    const vsCell = cells.find((c) => /\s[-–]\s/.test(c) || /\sv\s/i.test(c) || /\svs?\s/i.test(c));
    let homeRaw = "";
    let awayRaw = "";
    if (vsCell) {
      const parts = vsCell.split(/\s[-–]\s|\sv\s|\svs?\s/i);
      homeRaw = parts[0]?.trim() ?? "";
      awayRaw = parts[1]?.trim() ?? "";
    }
    if (!homeRaw || !awayRaw) continue;

    const leagueMatch = rowHtml.match(/data-competition="([^"]+)"/i);
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

    const pick1x2 = (cells.find((c) => /^(1|X|2)$/i.test(c)) as "1" | "X" | "2" | undefined) ?? undefined;
    const correctScore = cells.find((c) => /^\d-\d$/.test(c)) ?? undefined;
    const ou25 = (cells.find((c) => /^(over|under)$/i.test(c)) as "over" | "under" | undefined) ?? undefined;
    const btts = (cells.find((c) => /^(yes|no)$/i.test(c)) as "yes" | "no" | undefined) ?? undefined;

    // StatArea exposes probability % cells like "55%" "23%" "22%"
    const probMatches = cells
      .filter((c) => /^\d{1,3}%$/.test(c))
      .map((c) => Number(c.replace("%", "")) / 100);
    const probabilities = probMatches.length >= 3
      ? { home: probMatches[0], draw: probMatches[1], away: probMatches[2] }
      : undefined;

    const prediction: RawSourcePrediction = {
      "1x2": pick1x2,
      correctScore,
      ou25,
      btts,
      probabilities,
      raw: { source: SOURCE_NAME, cells },
    };

    results.push({ match, prediction });
  }
  return results;
}

export async function scrapeStatarea(targetDate?: string): Promise<ScrapeResult> {
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
    const matches = parseStatareaHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from StatArea HTML",
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
