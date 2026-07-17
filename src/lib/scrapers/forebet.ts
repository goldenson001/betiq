/**
 * Forebet scraper — algorithmic statistical predictions.
 *
 * Forebet publishes predicted scores, 1X2 probability percentages, BTTS%
 * and Over/Under% for thousands of daily matches. The site is HTML-only
 * (no public JSON API) and historically uses Cloudflare protection, so
 * requests may fail intermittently. We gracefully return an empty result
 * when the page can't be fetched or parsed.
 *
 * ESPN is the canonical source for fixtures; Forebet is best-effort and
 * only attaches picks to matches ESPN already returned for the same date.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "forebet";
const SOURCE_URL = "https://www.forebet.com/en/football-tips-and-predictions-for-today";

interface ForebetRow {
  homeRaw: string;
  awayRaw: string;
  timeStr: string;
  leagueRaw: string;
  // Forebet publishes numeric probabilities: 1%, X%, 2%, BTTS yes%, Over 2.5%
  pHome?: number;
  pDraw?: number;
  pAway?: number;
  predictedScore?: string; // "2-1"
  bttsYesPct?: number;
  over25Pct?: number;
}

/**
 * Parse Forebet HTML. Each match row sits in a <tr> with class "tr_0" or "tr_1"
 * inside the main predictions table. Cells contain team names, predicted score,
 * probability columns, and BTTS/O/U percentages.
 */
function parseForebetHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];

  // Match rows in the main tips table
  const rowMatches = html.match(/<tr[^>]*class="[^"]*tr_[01][^"]*"[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  for (const rowHtml of rowMatches) {
    const cells = (rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => stripHtml(c).trim());
    if (cells.length < 6) continue;

    // Forebet layout (varies but typically):
    //  [date/time] [league] [home v away] [1X2 probs] [score] [avg goals] [BTTS%] [O/U%]
    // We try to extract time, teams, league, then numeric % values.
    const timeMatch = cells.find((c) => /^\d{1,2}:\d{2}$/.test(c));
    const scoreMatch = cells.find((c) => /^\d+-\d+$/.test(c));
    const teamsCell = cells.find((c) => c.includes(" - ") || c.toLowerCase().includes(" v "));
    if (!teamsCell) continue;

    const sep = teamsCell.includes(" - ") ? " - " : / v(s|s\.)? /i;
    const teamParts = teamsCell.split(sep).map((s) => s.trim());
    if (teamParts.length < 2) continue;
    const homeRaw = teamParts[0];
    const awayRaw = teamParts[1];
    if (!homeRaw || !awayRaw || homeRaw.length < 2 || awayRaw.length < 2) continue;

    // League is usually the cell after date/time
    const timeIdx = cells.indexOf(timeMatch ?? "");
    const leagueRaw = cells[timeIdx + 1] ?? cells[1] ?? "Unknown";

    // Extract numeric percentages — Forebet shows them as plain "45%" or as
    // sub-elements. Pull all percentage values out of the row.
    const allPcts = (rowHtml.match(/(\d{1,3})%/g) ?? []).map((s) => parseInt(s, 10));
    const pHome = allPcts[0] !== undefined ? allPcts[0] / 100 : undefined;
    const pDraw = allPcts[1] !== undefined ? allPcts[1] / 100 : undefined;
    const pAway = allPcts[2] !== undefined ? allPcts[2] / 100 : undefined;
    const bttsYesPct = allPcts[3] !== undefined ? allPcts[3] / 100 : undefined;
    const over25Pct = allPcts[4] !== undefined ? allPcts[4] / 100 : undefined;

    // Determine 1X2 pick from highest probability
    let pick1x2: "1" | "X" | "2" | undefined;
    if (pHome !== undefined && pDraw !== undefined && pAway !== undefined) {
      if (pHome >= pDraw && pHome >= pAway) pick1x2 = "1";
      else if (pAway >= pDraw) pick1x2 = "2";
      else pick1x2 = "X";
    }

    // BTTS pick
    let btts: "yes" | "no" | undefined;
    if (bttsYesPct !== undefined) btts = bttsYesPct >= 0.5 ? "yes" : "no";

    // O/U 2.5 pick
    let ou25: "over" | "under" | undefined;
    if (over25Pct !== undefined) ou25 = over25Pct >= 0.5 ? "over" : "under";

    const home = normalizeTeam(homeRaw);
    const away = normalizeTeam(awayRaw);
    const { name: leagueName, country } = normalizeLeague(leagueRaw);
    const timeStr = timeMatch ?? "12:00";
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
      correctScore: scoreMatch,
      btts,
      ou25,
      probabilities: (pHome !== undefined || pDraw !== undefined || pAway !== undefined)
        ? { home: pHome, draw: pDraw, away: pAway }
        : undefined,
      raw: { source: SOURCE_NAME, homeRaw, awayRaw, leagueRaw, pHome, pDraw, pAway, bttsYesPct, over25Pct },
    };

    results.push({ match, prediction });
  }

  return results;
}

export async function scrapeForebet(targetDate?: string): Promise<ScrapeResult> {
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
    const matches = parseForebetHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from Forebet HTML (Cloudflare may have blocked)",
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
