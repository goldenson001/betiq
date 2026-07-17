/**
 * Adibet scraper — daily picks (1X2, BTTS, O/U) for top leagues.
 *
 * Adibet publishes daily "sure picks" tables with team names, league,
 * tip (1X2), and a confidence rating. The HTML is simple and scrapeable.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "adibet";
const SOURCE_URL = "https://www.adibet.com/";

function parseAdibetHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];

  for (const rowHtml of rowMatches) {
    const cells = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => stripHtml(c).trim());
    if (cells.length < 4) continue;

    // Adibet layout: [time] [league] [home v away] [tip] [odds?]
    const timeMatch = cells.find((c) => /^\d{1,2}:\d{2}$/.test(c));
    if (!timeMatch) continue;

    const teamsCell = cells.find((c) => c.includes(" v ") || c.includes(" vs ") || c.includes(" - "));
    if (!teamsCell) continue;

    const sep = teamsCell.includes(" v ") ? " v " : teamsCell.includes(" vs ") ? " vs " : " - ";
    const [homeRaw, awayRaw] = teamsCell.split(sep).map((s) => s.trim());
    if (!homeRaw || !awayRaw || homeRaw.length < 2 || awayRaw.length < 2) continue;

    // Tip cell — "1", "X", "2", "1X", "X2", "GG", "NG", "OV2.5", "UN2.5"
    const tipCell = cells.find((c) =>
      /^(1|X|2|1X|X2|12|GG|NG|OV2\.5|UN2\.5|OV1\.5|UN1\.5)$/i.test(c)
    );
    if (!tipCell) continue;

    let pick1x2: "1" | "X" | "2" | undefined;
    let btts: "yes" | "no" | undefined;
    let ou25: "over" | "under" | undefined;
    const tip = tipCell.toUpperCase();
    if (["1", "X", "2"].includes(tip)) pick1x2 = tip as "1" | "X" | "2";
    if (tip === "GG") btts = "yes";
    if (tip === "NG") btts = "no";
    if (tip === "OV2.5") ou25 = "over";
    if (tip === "UN2.5") ou25 = "under";

    const leagueRaw = cells[1] ?? "Unknown";
    const home = normalizeTeam(homeRaw);
    const away = normalizeTeam(awayRaw);
    const { name: leagueName, country } = normalizeLeague(leagueRaw);
    const utc = brusselsTimeToUtc(targetDate, timeMatch);

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
      raw: { source: SOURCE_NAME, homeRaw, awayRaw, leagueRaw, tip: tipCell },
    };

    results.push({ match, prediction });
  }

  return results;
}

export async function scrapeAdibet(targetDate?: string): Promise<ScrapeResult> {
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
    const matches = parseAdibetHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from Adibet HTML",
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
