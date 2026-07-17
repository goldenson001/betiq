/**
 * PredictZ scraper — predicts all today's matches across leagues.
 * Tries to fetch live HTML from predictz.com; returns EMPTY result when the
 * site is unreachable. ESPN is the canonical source for fixtures.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml, regexExtract } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "predictz";
const SOURCE_URL = "https://www.predictz.com/predictions/today/";

/**
 * Parses PredictZ's HTML table of today's predictions.
 * The structure historically looks like:
 *   <tr>
 *     <td>14:00</td> <td>TeamA</td> <td>v</td> <td>TeamB</td>
 *     <td>1</td> <td>X</td> <td>2</td>
 *     <td>2-1</td> <td>over</td> <td>yes</td>
 *   </tr>
 */
function parsePredictzHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];
  // Grab table rows
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  for (const rowHtml of rowMatches) {
    const cells = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) =>
      stripHtml(c).trim()
    );
    if (cells.length < 8) continue;

    const timeStr = cells[0];
    // Validate time format HH:MM
    if (!/^\d{1,2}:\d{2}$/.test(timeStr)) continue;

    const homeRaw = cells[1];
    const awayRaw = cells[3] ?? cells[2];
    if (!homeRaw || !awayRaw || homeRaw.length < 2 || awayRaw.length < 2) continue;
    if (/^v(s|s\.)?$/i.test(homeRaw) || /^v(s|s\.)?$/i.test(awayRaw)) continue;

    // Find league header from preceding <h2>/<h3> or league column
    const leagueMatch = rowHtml.match(/data-league="([^"]+)"/i);
    const leagueRaw = leagueMatch?.[1] ?? "Unknown";

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

    // PredictZ columns often: time, home, v, away, league, 1, X, 2, score, ou, btts
    const pick1x2 = (cells.find((c) => /^(1|X|2)$/i.test(c)) ?? null) as "1" | "X" | "2" | null;
    const correctScore = cells.find((c) => /^\d-\d$/.test(c)) ?? undefined;
    const ou25 = (cells.find((c) => /^(over|under)$/i.test(c)) as "over" | "under" | undefined) ?? undefined;
    const btts = (cells.find((c) => /^(yes|no)$/i.test(c)) as "yes" | "no" | undefined) ?? undefined;

    const prediction: RawSourcePrediction = {
      "1x2": pick1x2 ?? undefined,
      correctScore,
      ou25,
      btts,
      raw: { source: SOURCE_NAME, cells },
    };

    results.push({ match, prediction });
  }
  return results;
}

export async function scrapePredictz(targetDate?: string): Promise<ScrapeResult> {
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
    const matches = parsePredictzHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from PredictZ HTML",
      };
    }
    return {
      source: SOURCE_NAME,
      matches,
      startedAt,
      finishedAt: new Date(),
    };
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
