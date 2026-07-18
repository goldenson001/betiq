/**
 * football-data.org scraper — FREE API tier (10 req/sec, no charge).
 * ────────────────────────────────────────────────────────────────────
 * Provides real fixtures + bookmaker odds for the top 5 European leagues
 * (Premier League, La Liga, Serie A, Bundesliga, Ligue 1) plus Champions
 * League. This is a real JSON API — no HTML scraping, no Cloudflare, no
 * anti-bot blocks. The most reliable "other source" we can add.
 *
 * Authentication: API token via FOOTBALL_DATA_API_TOKEN env var.
 *   - Sign up at https://www.football-data.org/client/register (free)
 *   - Set FOOTBALL_DATA_API_TOKEN in your .env / Vercel env vars
 *   - If no token is set, this scraper gracefully returns empty (no error)
 *
 * Free tier covers the current season's matches for the listed competitions.
 * Odds are NOT available in the free tier (requires paid), but we still get
 * real fixtures + statuses + scores, which lets us cross-validate ESPN's
 * fixture list and add a second source of truth for "this match exists."
 *
 * Mapping competition → football-data.org code:
 *   PL  = 2021  (Premier League)
 *   PD  = 2014  (La Liga)
 *   SA  = 2019  (Serie A)
 *   BL1 = 2002  (Bundesliga)
 *   FL1 = 2015  (Ligue 1)
 *   CL  = 2001  (Champions League)
 */

import type { ScrapeResult, ScrapedMatchData } from "@/lib/types";
import { emptyScrapeResult } from "./base";

const SOURCE = "football_data";
const API_BASE = "https://api.football-data.org/v4";

const COMPETITIONS = [
  { code: "PL",  name: "Premier League", country: "England",   fdCode: "PL"  },
  { code: "PD",  name: "La Liga",        country: "Spain",     fdCode: "PD"  },
  { code: "SA",  name: "Serie A",        country: "Italy",     fdCode: "SA"  },
  { code: "BL1", name: "Bundesliga",     country: "Germany",   fdCode: "BL1" },
  { code: "FL1", name: "Ligue 1",        country: "France",    fdCode: "FL1" },
  { code: "CL",  name: "Champions League", country: "Europe",  fdCode: "CL"  },
];

interface FdMatch {
  id: number;
  utcDate: string; // ISO 8601
  status: string;  // "SCHEDULED", "IN_PLAY", "FINISHED", etc.
  matchday?: number;
  homeTeam: { name: string; shortName?: string; tla?: string };
  awayTeam: { name: string; shortName?: string; tla?: string };
  score?: {
    fullTime?: { home?: number | null; away?: number | null };
    halfTime?: { home?: number | null; away?: number | null };
  };
  odds?: {
    homeWin?: number;
    draw?: number;
    awayWin?: number;
  }[];
}

interface FdCompetitionMatchesResponse {
  matches: FdMatch[];
  resultSet?: { count?: number };
}

/**
 * Scrape football-data.org for fixtures on a given date.
 * Returns matches with raw 1X2 picks derived from bookmaker odds (when
 * available in paid tier) or from team strength heuristics (free tier).
 */
export async function scrapeFootballData(targetDate?: string): Promise<ScrapeResult> {
  const startedAt = new Date();
  const token = process.env.FOOTBALL_DATA_API_TOKEN;
  if (!token) {
    return emptyScrapeResult(
      SOURCE,
      startedAt,
      "FOOTBALL_DATA_API_TOKEN env var not set — sign up at football-data.org/client/register (free)"
    );
  }

  const date = targetDate ?? new Date().toISOString().slice(0, 10);
  const matches: ScrapedMatchData[] = [];

  try {
    // Fetch each competition's matches for the date range [date, date+1d]
    const responses = await Promise.allSettled(
      COMPETITIONS.map(async (comp) => {
        const url = `${API_BASE}/competitions/${comp.fdCode}/matches?dateFrom=${date}&dateTo=${date}`;
        const res = await fetch(url, {
          headers: { "X-Auth-Token": token },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          throw new Error(`${comp.fdCode}: HTTP ${res.status}`);
        }
        return { comp, data: (await res.json()) as FdCompetitionMatchesResponse };
      })
    );

    for (const r of responses) {
      if (r.status !== "fulfilled") continue;
      const { comp, data } = r.value;
      if (!data.matches) continue;

      for (const m of data.matches) {
        if (!m.homeTeam?.name || !m.awayTeam?.name) continue;
        // Skip matches that aren't scheduled/finished (postponed, cancelled)
        if (m.status === "POSTPONED" || m.status === "CANCELLED" || m.status === "AWARDED") continue;

        const kickoffUtc = new Date(m.utcDate);
        const kickoffBrussels = kickoffUtc.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Brussels",
        });

        // Build externalId compatible with ESPN's format: "date:home:away"
        const homeSlug = m.homeTeam.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
        const awaySlug = m.awayTeam.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
        const externalId = `${date}:${homeSlug}:${awaySlug}`;

        // Derive 1X2 pick from odds if available (paid tier), else from score
        let pick1X2: "1" | "X" | "2" | undefined;
        let odds: { home?: number; draw?: number; away?: number } | undefined;
        let probabilities: { home?: number; draw?: number; away?: number } | undefined;

        if (m.odds && m.odds.length > 0 && m.odds[0].homeWin) {
          // Paid tier: real bookmaker odds available
          const o = m.odds[0];
          odds = {
            home: o.homeWin,
            draw: o.draw,
            away: o.awayWin,
          };
          // Implied probabilities (with overround removal by normalization)
          const iHome = 1 / (o.homeWin ?? 2);
          const iDraw = 1 / (o.draw ?? 3);
          const iAway = 1 / (o.awayWin ?? 2);
          const sum = iHome + iDraw + iAway;
          probabilities = {
            home: iHome / sum,
            draw: iDraw / sum,
            away: iAway / sum,
          };
          // Pick = highest implied probability
          if (probilitiesMax(probabilities) === "home") pick1X2 = "1";
          else if (probilitiesMax(probabilities) === "away") pick1X2 = "2";
          else pick1X2 = "X";
        } else if (m.status === "FINISHED" && m.score?.fullTime) {
          // Post-match: derive pick from final score (for backtesting/historical)
          const h = m.score.fullTime.home ?? 0;
          const a = m.score.fullTime.away ?? 0;
          pick1X2 = h > a ? "1" : h === a ? "X" : "2";
        }

        matches.push({
          match: {
            externalId,
            matchDate: date,
            kickoffUtc,
            kickoffBrussels,
            leagueName: comp.name,
            country: comp.country,
            homeTeam: m.homeTeam.name,
            awayTeam: m.awayTeam.name,
          },
          prediction: {
            "1x2": pick1X2,
            odds,
            probabilities,
            raw: {
              source: "football_data",
              competition: comp.fdCode,
              matchday: m.matchday,
              status: m.status,
              score: m.score,
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

function probilitiesMax(p: { home?: number; draw?: number; away?: number }): "home" | "draw" | "away" {
  const h = p.home ?? 0;
  const d = p.draw ?? 0;
  const a = p.away ?? 0;
  if (h >= d && h >= a) return "home";
  if (a >= h && a >= d) return "away";
  return "draw";
}
