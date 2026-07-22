/**
 * the-odds-api.com scraper — FREE API tier (500 requests/month, no charge).
 * ───────────────────────────────────────────────────────────────────────
 * Provides REAL bookmaker odds from multiple soft & sharp books (Pinnacle,
 * DraftKings, BetMGM, etc.) for soccer matches worldwide. This is the most
 * reliable way to get real market odds — no HTML scraping, no anti-bot blocks.
 *
 * Authentication: API key via THE_ODDS_API_KEY env var.
 *   - Sign up at https://the-odds-api.com/liveapi/guides/v4/ (free)
 *   - Set THE_ODDS_API_KEY in your .env / Vercel env vars
 *   - If no key is set, this scraper gracefully returns empty (no error)
 *
 * Free tier covers:
 *   - 500 requests/month (one request fetches all today's matches)
 *   - Soccer leagues: EPL, La Liga, Serie A, Bundesliga, Ligue 1, UCL, UEL,
 *     MLS, Brasileirão, plus many more
 *   - Real bookmaker odds (decimal format) from 10+ sportsbooks
 *   - H2H (1X2), Spreads (Asian Handicap), Totals (O/U)
 *
 * This source provides the highest-quality odds data in the system — better
 * than ESPN's DraftKings snapshot, because it aggregates multiple books.
 *
 * Note: the-odds-api uses American-style team names ("Manchester City" not
 * "Man City"). We normalize to lowercase slugs for externalId matching.
 */

import type { ScrapeResult, ScrapedMatchData } from "@/lib/types";
import { emptyScrapeResult } from "./base";

const SOURCE = "the_odds_api";
const API_BASE = "https://api.the-odds-api.com/v4";

interface OddsApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string; // ISO 8601
  home_team: string;
  away_team: string;
  bookmakers?: {
    key: string;       // "pinnacle", "draftkings", etc.
    title: string;
    markets: {
      key: string;     // "h2h", "spreads", "totals"
      outcomes: {
        name: string;
        price: number;  // decimal odds
        point?: number; // for spreads/totals
      }[];
    }[];
  }[];
}

interface OddsApiResponse extends Array<OddsApiEvent> {}

/**
 * Scrape the-odds-api for today's soccer matches with real bookmaker odds.
 * Uses the /sports/soccer_* endpoints to fetch all soccer leagues at once.
 *
 * Strategy:
 *   1. List all soccer sport keys (one request)
 *   2. For each sport, fetch today's odds (one request per sport)
 *   3. Aggregate best odds across books (highest home/draw/away price)
 *   4. Derive 1X2 pick from the average implied probability across books
 *
 * Returns matches with full odds data attached.
 */
export async function scrapeTheOddsApi(targetDate?: string): Promise<ScrapeResult> {
  const startedAt = new Date();
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    return emptyScrapeResult(
      SOURCE,
      startedAt,
      "THE_ODDS_API_KEY env var not set — sign up at the-odds-api.com (free 500 req/month)"
    );
  }

  const date = targetDate ?? new Date().toISOString().slice(0, 10);

  try {
    // Step 1: Get list of all available soccer sports
    const sportsRes = await fetch(`${API_BASE}/sports/?apiKey=${apiKey}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!sportsRes.ok) {
      throw new Error(`sports list: HTTP ${sportsRes.status}`);
    }
    const sports = (await sportsRes.json()) as Array<{ key: string; title: string; group: string }>;
    const soccerSports = sports.filter((s) => s.group === "Soccer");

    if (soccerSports.length === 0) {
      return emptyScrapeResult(SOURCE, startedAt, "No soccer sports available");
    }

    // Step 2: Fetch odds for each soccer sport.
    // Configurable via THE_ODDS_API_SPORTS_LIMIT env var — default 20 covers
    // the major European leagues + South American leagues (Brasileirão,
    // Argentine Primera, MLS, etc.) that were previously missed by the
    // hard-coded slice(0, 8) cap. Lower this if you need to conserve API
    // quota (each sport fetched costs ~10-20 quota units per scrape).
    const sportsLimit = Number(process.env.THE_ODDS_API_SPORTS_LIMIT ?? "20");
    const topSports = soccerSports.slice(0, Number.isFinite(sportsLimit) ? sportsLimit : 20);
    const matches: ScrapedMatchData[] = [];

    const responses = await Promise.allSettled(
      topSports.map(async (sport) => {
        // Use 'commence_time_from' and 'commence_time_to' to limit to target date
        const fromDate = `${date}T00:00:00Z`;
        const toDate = `${date}T23:59:59Z`;
        const url = `${API_BASE}/sports/${sport.key}/odds/?apiKey=${apiKey}&regions=eu,uk&markets=h2h&oddsFormat=decimal&commenceTimeFrom=${fromDate}&commenceTimeTo=${toDate}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) {
          throw new Error(`${sport.key}: HTTP ${res.status}`);
        }
        return { sport: sport.title, data: (await res.json()) as OddsApiResponse };
      })
    );

    for (const r of responses) {
      if (r.status !== "fulfilled") continue;
      const { sport: sportTitle, data } = r.value;

      for (const event of data) {
        if (!event.home_team || !event.away_team) continue;

        const kickoffUtc = new Date(event.commence_time);
        // Filter: only matches on the target date
        if (kickoffUtc.toISOString().slice(0, 10) !== date) continue;

        const kickoffBrussels = kickoffUtc.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Brussels",
        });

        const homeSlug = event.home_team.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
        const awaySlug = event.away_team.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
        const externalId = `${date}:${homeSlug}:${awaySlug}`;

        // Aggregate best odds across books
        let bestHome = 0, bestDraw = 0, bestAway = 0;
        let bookCount = 0;
        if (event.bookmakers) {
          for (const book of event.bookmakers) {
            const h2h = book.markets.find((m) => m.key === "h2h");
            if (!h2h) continue;
            bookCount++;
            for (const o of h2h.outcomes) {
              if (o.name === event.home_team && o.price > bestHome) bestHome = o.price;
              else if (o.name === "Draw" && o.price > bestDraw) bestDraw = o.price;
              else if (o.name === event.away_team && o.price > bestAway) bestAway = o.price;
            }
          }
        }

        // Fallback: if no odds (rare), skip this match
        if (bestHome === 0 || bestAway === 0) continue;

        // Compute average implied probability across books (best odds = lowest vig)
        // Using best odds gives the "sharpest" market view (closest to true probability)
        const iHome = 1 / bestHome;
        const iDraw = bestDraw > 0 ? 1 / bestDraw : 0;
        const iAway = 1 / bestAway;
        const sum = iHome + iDraw + iAway;
        const probabilities = {
          home: iHome / sum,
          draw: iDraw / sum,
          away: iAway / sum,
        };

        // Pick = highest implied probability
        let pick1X2: "1" | "X" | "2";
        if (probabilities.home >= probabilities.draw && probabilities.home >= probabilities.away) pick1X2 = "1";
        else if (probabilities.away >= probabilities.home && probabilities.away >= probabilities.draw) pick1X2 = "2";
        else pick1X2 = "X";

        // Derive country from sport title (e.g. "EPL - England" → "England")
        const country = sportTitle.includes(" - ")
          ? sportTitle.split(" - ")[1].trim()
          : sportTitle.includes("UEFA") ? "Europe" : "World";

        matches.push({
          match: {
            externalId,
            matchDate: date,
            kickoffUtc,
            kickoffBrussels,
            leagueName: sportTitle,
            country,
            homeTeam: event.home_team,
            awayTeam: event.away_team,
          },
          prediction: {
            "1x2": pick1X2,
            odds: {
              home: bestHome,
              draw: bestDraw > 0 ? bestDraw : undefined,
              away: bestAway,
            },
            probabilities,
            raw: {
              source: "the_odds_api",
              sport_key: event.sport_key,
              bookCount,
              eventId: event.id,
            },
          },
        });
      }
    }

    return {
      source: SOURCE,
      matches,
      startedAt,
      finishedAt: new Date(),
    };
  } catch (err) {
    return emptyScrapeResult(SOURCE, startedAt, String(err));
  }
}
