/**
 * SoccerVista scraper — daily picks with 1X2, BTTS, O/U tips.
 *
 * SoccerVista publishes today's predictions as an HTML table with team
 * names, league, pick (1X2), and confidence flag. Layout is fairly
 * stable and scrapeable with simple regex.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "soccerista";
const SOURCE_URL = "https://www.soccervista.com/soccer_predictions.php";

function parseSoccerVistaHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];

  for (const rowHtml of rowMatches) {
    const cells = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => stripHtml(c).trim());
    if (cells.length < 5) continue;

    // SoccerVista layout typically:
    //  [date] [league] [home - away] [pick] [odds] [score?]
    const teamsCell = cells.find((c) => c.includes(" - "));
    if (!teamsCell) continue;

    const [homeRaw, awayRaw] = teamsCell.split(" - ").map((s) => s.trim());
    if (!homeRaw || !awayRaw || homeRaw.length < 2 || awayRaw.length < 2) continue;

    const timeMatch = cells.find((c) => /^\d{1,2}:\d{2}$/.test(c));
    const timeStr = timeMatch ?? "12:00";

    // Find the pick — usually a single "1", "X", "2", "1X", "X2", "12"
    const pickCell = cells.find((c) => /^(1|X|2|1X|X2|12)$/i.test(c));
    const pick1x2 = (pickCell as "1" | "X" | "2" | undefined) ?? undefined;

    // Look for BTTS hint in row
    const bttsCell = cells.find((c) => /gg|ng|btts/i.test(c));
    let btts: "yes" | "no" | undefined;
    if (bttsCell) {
      if (/gg|yes/i.test(bttsCell)) btts = "yes";
      else if (/ng|no/i.test(bttsCell)) btts = "no";
    }

    // Look for O/U
    const ouCell = cells.find((c) => /over|under/i.test(c));
    let ou25: "over" | "under" | undefined;
    if (ouCell) {
      ou25 = /over/i.test(ouCell) ? "over" : "under";
    }

    // League is usually cells[1] or first non-time, non-team cell
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
      raw: { source: SOURCE_NAME, homeRaw, awayRaw, leagueRaw, cells },
    };

    results.push({ match, prediction });
  }

  return results;
}

export async function scrapeSoccerVista(targetDate?: string): Promise<ScrapeResult> {
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
    const matches = parseSoccerVistaHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from SoccerVista HTML",
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
