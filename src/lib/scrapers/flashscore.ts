/**
 * FlashScore scraper — fixtures, live scores, and form data.
 *
 * NOTE: FlashScore uses heavy JavaScript rendering with Cloudflare anti-bot
 * protection. The static HTML returned by a plain HTTP fetch will NOT
 * contain the matches table — it loads dynamically via XHR after the page
 * boots. This scraper will therefore almost always return 0 matches.
 *
 * We still attempt it because:
 *   - Sometimes the bot protection is temporarily off
 *   - The scraper gracefully returns an empty result on failure
 *   - When it does work, it provides useful form/H2H signals
 *
 * ESPN remains the canonical fixture source.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation, stripHtml } from "./http";
import { normalizeLeague, normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime, brusselsTimeToUtc } from "@/lib/time/brussels";

const SOURCE_NAME = "flashscore";
const SOURCE_URL = "https://www.flashscore.com/football/";

function parseFlashScoreHtml(html: string, targetDate: string): ScrapedMatchData[] {
  const results: ScrapedMatchData[] = [];

  // FlashScore's static HTML usually has match IDs in <a href="/match/...">
  // but team names are inserted via JS. Try to extract from meta tags or
  // data attributes.
  const matchLinks = html.match(/<a[^>]*href="\/match\/[^"]+"[^>]*>[\s\S]*?<\/a>/gi) ?? [];

  for (const linkHtml of matchLinks) {
    // Try data-home-name / data-away-name attributes
    const homeMatch = linkHtml.match(/data-home-name="([^"]+)"/i);
    const awayMatch = linkHtml.match(/data-away-name="([^"]+)"/i);
    if (!homeMatch || !awayMatch) continue;

    const homeRaw = homeMatch[1];
    const awayRaw = awayMatch[1];
    if (!homeRaw || !awayRaw || homeRaw.length < 2 || awayRaw.length < 2) continue;

    const leagueMatch = linkHtml.match(/data-league="([^"]+)"/i);
    const leagueRaw = leagueMatch?.[1] ?? "Unknown";

    const timeMatch = linkHtml.match(/(\d{1,2}:\d{2})/);
    const timeStr = timeMatch?.[1] ?? "12:00";

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

    // FlashScore static HTML rarely has odds/picks — we record team names only
    const prediction: RawSourcePrediction = {
      raw: { source: SOURCE_NAME, homeRaw, awayRaw, leagueRaw, note: "static HTML scrape — picks unavailable without JS rendering" },
    };

    results.push({ match, prediction });
  }

  return results;
}

export async function scrapeFlashScore(targetDate?: string): Promise<ScrapeResult> {
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
    const matches = parseFlashScoreHtml(html, dateStr);
    if (matches.length === 0) {
      return {
        source: SOURCE_NAME,
        matches: [],
        startedAt,
        finishedAt: new Date(),
        error: "parsed 0 matches from FlashScore HTML (JS-rendered content — expected on serverless)",
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

// Used by stripHtml re-export to silence unused-import linters if configured
// (kept here so the import pattern is consistent with sibling scrapers).
void stripHtml;
