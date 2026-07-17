/**
 * Vitibet scraper — daily predictions with 1X2, O/U, BTTS tips.
 *
 * Vitibet publishes a "Today's Predictions" table with team names, league,
 * tip, and confidence. The HTML is a simple <table> with predictable columns.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "vitibet";
const SOURCE_URL = "https://www.vitibet.com/freepredictions";

function parseVitibetHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];

  for (const rowHtml of rowMatches) {
    const cells = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => stripHtml(c).trim());
    if (cells.length < 5) continue;

    // Vitibet layout: [date/time] [league] [home v away] [tip] [score] [odds]
    const timeMatch = cells.find((c) => /\d{1,2}:\d{2}/.test(c));
    if (!timeMatch) continue;
    const timeStr = (timeMatch.match(/\d{1,2}:\d{2}/) ?? ["12:00"])[0];

    const teamsCell = cells.find((c) =>
      / v | vs | - /.test(c) && c.length > 4 && c.length < 80
    );
    if (!teamsCell) continue;

    const sepMatch = teamsCell.match(/ v | vs | - /);
    if (!sepMatch) continue;
    const sep = sepMatch[0];
    const sepIdx = teamsCell.indexOf(sep);
    const homeRaw = teamsCell.slice(0, sepIdx).trim();
    const awayRaw = teamsCell.slice(sepIdx + sep.length).trim();
    if (!homeRaw || !awayRaw || homeRaw.length < 2 || awayRaw.length < 2) continue;

    // Tip — same pattern as Adibet
    const tipCell = cells.find((c) =>
      /^(1|X|2|1X|X2|12|GG|NG|OV2\.5|UN2\.5|OV1\.5|UN1\.5|BTTS|YES|NO)$/i.test(c)
    );

    let pick1x2: "1" | "X" | "2" | undefined;
    let btts: "yes" | "no" | undefined;
    let ou25: "over" | "under" | undefined;
    if (tipCell) {
      const tip = tipCell.toUpperCase();
      if (["1", "X", "2"].includes(tip)) pick1x2 = tip as "1" | "X" | "2";
      if (tip === "GG" || tip === "BTTS" || tip === "YES") btts = "yes";
      if (tip === "NG" || tip === "NO") btts = "no";
      if (tip === "OV2.5") ou25 = "over";
      if (tip === "UN2.5") ou25 = "under";
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
      raw: { source: SOURCE_NAME, homeRaw, awayRaw, leagueRaw, tip: tipCell },
    };

    results.push({ match, prediction });
  }

  return results;
}

export async function scrapeVitibet(targetDate?: string): Promise<ScrapeResult> {
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
    const matches = parseVitibetHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from Vitibet HTML",
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
