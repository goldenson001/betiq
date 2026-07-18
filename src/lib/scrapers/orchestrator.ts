/**
 * Scraper orchestrator — fetches REAL fixtures from ESPN (no key needed),
 * plus attempts HTML scraping from prediction sites (predictz, windrawwin,
 * statarea) when reachable. ESPN is the source of truth for the fixture list
 * and team metadata; the prediction sites add consensus picks on top.
 *
 * All matches stored have a real externalId derived from real ESPN fixtures.
 * No synthetic fallback data is ever written to the database.
 */

import { db } from "@/lib/db";
import type { ScrapeResult, ScrapedMatchData, NormalizedMatch } from "@/lib/types";
import { scrapeEspn, ESPN_LEAGUE_COUNT } from "./espn";
import { scrapePredictz } from "./predictz";
import { scrapeWindrawwin } from "./windrawwin";
import { scrapeStatarea } from "./statarea";
import { scrapeForebet } from "./forebet";
import { scrapeBetExplorer } from "./betexplorer";
import { scrapeSoccerVista } from "./soccervista";
import { scrapeAdibet } from "./adibet";
import { scrapeVitibet } from "./vitibet";
import { scrapeSoccerstats } from "./soccerstats";
import { scrapeFlashScore } from "./flashscore";
// D2: Reliable API-based sources (no HTML scraping, no Cloudflare blocks)
import { scrapeFootballData } from "./football-data";
import { scrapeTheOddsApi } from "./the-odds-api";

interface SourceDef {
  name: string;
  displayName: string;
  url: string;
  /** When true, this source provides match fixtures (not just predictions). */
  providesFixtures: boolean;
  scrape: (date?: string) => Promise<ScrapeResult>;
}

const SOURCES: SourceDef[] = [
  {
    name: "espn",
    displayName: "ESPN",
    url: "https://site.api.espn.com/apis/site/v2/sports/soccer",
    providesFixtures: true,
    scrape: scrapeEspn,
  },
  {
    name: "predictz",
    displayName: "PredictZ",
    url: "https://www.predictz.com",
    providesFixtures: false,
    scrape: scrapePredictz,
  },
  {
    name: "windrawwin",
    displayName: "WindDrawWin",
    url: "https://www.windrawwin.com",
    providesFixtures: false,
    scrape: scrapeWindrawwin,
  },
  {
    name: "statarea",
    displayName: "StatArea",
    url: "https://www.statarea.com",
    providesFixtures: false,
    scrape: scrapeStatarea,
  },
  {
    name: "forebet",
    displayName: "Forebet",
    url: "https://www.forebet.com",
    providesFixtures: false,
    scrape: scrapeForebet,
  },
  {
    name: "betexplorer",
    displayName: "BetExplorer",
    url: "https://www.betexplorer.com",
    providesFixtures: false,
    scrape: scrapeBetExplorer,
  },
  {
    name: "soccerista",
    displayName: "SoccerVista",
    url: "https://www.soccervista.com",
    providesFixtures: false,
    scrape: scrapeSoccerVista,
  },
  {
    name: "adibet",
    displayName: "Adibet",
    url: "https://www.adibet.com",
    providesFixtures: false,
    scrape: scrapeAdibet,
  },
  {
    name: "vitibet",
    displayName: "Vitibet",
    url: "https://www.vitibet.com",
    providesFixtures: false,
    scrape: scrapeVitibet,
  },
  {
    name: "soccerstats",
    displayName: "Soccerstats",
    url: "https://www.soccerstats.com",
    providesFixtures: false,
    scrape: scrapeSoccerstats,
  },
  {
    name: "flashscore",
    displayName: "FlashScore",
    url: "https://www.flashscore.com",
    providesFixtures: false,
    scrape: scrapeFlashScore,
  },
  // ── D2: Reliable API-based sources (free tiers, real JSON APIs) ────────────
  // These don't depend on HTML scraping, so they actually work reliably.
  // Both require API keys (free tier available) — if the key isn't set, the
  // scraper gracefully returns empty (no error), and the source still shows
  // up in the dashboard with a "needs API key" status.
  {
    name: "football_data",
    displayName: "football-data.org",
    url: "https://www.football-data.org",
    providesFixtures: true, // Real fixtures from JSON API
    scrape: scrapeFootballData,
  },
  {
    name: "the_odds_api",
    displayName: "The Odds API",
    url: "https://the-odds-api.com",
    providesFixtures: true, // Real fixtures + multi-book odds
    scrape: scrapeTheOddsApi,
  },
];

export async function ensureSources(): Promise<void> {
  for (const s of SOURCES) {
    const existing = await db.source.findUnique({ where: { name: s.name } });
    // Starting weights:
    //   - ESPN:              0.7 (canonical fixtures + odds + H2H + form)
    //   - football-data.org: 0.5 (reliable API, real fixtures)
    //   - the-odds-api:      0.6 (best odds data, multi-book aggregation)
    //   - HTML scrapers:     0.3 (best-effort, often fail)
    const startingWeight =
      s.name === "espn" ? 0.7 :
      s.name === "the_odds_api" ? 0.6 :
      s.name === "football_data" ? 0.5 :
      0.3;
    if (!existing) {
      await db.source.create({
        data: {
          name: s.name,
          displayName: s.displayName,
          url: s.url,
          weight: startingWeight,
        },
      });
    } else {
      // Bump weights on existing installs for the reliable API-based sources
      if (s.name === "espn" && existing.weight < 0.6) {
        await db.source.update({ where: { id: existing.id }, data: { weight: 0.7 } });
      }
      if (s.name === "the_odds_api" && existing.weight < 0.5) {
        await db.source.update({ where: { id: existing.id }, data: { weight: 0.6 } });
      }
      if (s.name === "football_data" && existing.weight < 0.4) {
        await db.source.update({ where: { id: existing.id }, data: { weight: 0.5 } });
      }
    }
  }
}

export async function ensureLeague(name: string, country: string) {
  const existing = await db.league.findUnique({ where: { name } });
  if (existing) return existing;
  return db.league.create({ data: { name, country } });
}

/**
 * Run all scrapers in parallel. ESPN is the source of truth for fixtures.
 * The prediction sites are best-effort — if they fail, we still get matches
 * from ESPN with full bookmaker odds and metadata.
 */
export async function runAllScrapers(targetDate?: string): Promise<{
  startedAt: Date;
  finishedAt: Date;
  matchesStored: number;
  predictionsStored: number;
  results: ScrapeResult[];
}> {
  await ensureSources();
  const startedAt = new Date();

  // Run all scrapers in parallel
  const results = await Promise.allSettled(SOURCES.map((s) => s.scrape(targetDate)));
  const scrapeResults: ScrapeResult[] = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          source: SOURCES[i].name,
          matches: [],
          startedAt,
          finishedAt: new Date(),
          error: String(r.reason),
        }
  );

  // Persist scrape logs
  for (const sr of scrapeResults) {
    await db.scrapeLog.create({
      data: {
        source: sr.source,
        startedAt: sr.startedAt,
        finishedAt: sr.finishedAt,
        matchesFound: sr.matches.length,
        predictionsExtracted: sr.matches.length,
        status: sr.error ? "failed" : "success",
        error: sr.error,
      },
    });
  }

  let matchesStored = 0;
  let predictionsStored = 0;

  // ─── Phase 1: store all matches from fixture-providing sources (ESPN first) ───
  // ESPN is canonical for fixtures. Run it first so match rows exist before
  // we attach predictions from the other sources.
  const fixtureResults = scrapeResults
    .filter((sr) => SOURCES.find((s) => s.name === sr.source)?.providesFixtures)
    .sort((a, b) => {
      // ESPN first
      if (a.source === "espn") return -1;
      if (b.source === "espn") return 1;
      return 0;
    });

  const matchIdByExternalId = new Map<string, string>();

  for (const sr of fixtureResults) {
    const source = await db.source.findUnique({ where: { name: sr.source } });
    if (!source) continue;
    await db.source.update({
      where: { id: source.id },
      data: { lastScrapedAt: new Date() },
    });

    for (const item of sr.matches) {
      const m = item.match;
      const league = await ensureLeague(m.leagueName, m.country);

      // Extract H2H + form from ESPN's raw payload (other sources don't have it)
      const rawPayload = item.prediction.raw as Record<string, unknown> | undefined;
      const h2h = rawPayload?.h2h as unknown;
      const h2hJson = h2h ? JSON.stringify(h2h) : null;
      const homeForm = (rawPayload?.homeForm as string | undefined) ?? null;
      const awayForm = (rawPayload?.awayForm as string | undefined) ?? null;

      const match = await db.match.upsert({
        where: { externalId: m.externalId },
        create: {
          externalId: m.externalId,
          matchDate: m.matchDate,
          kickoffUtc: m.kickoffUtc,
          kickoffBrussels: m.kickoffBrussels,
          leagueId: league.id,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          status: "scheduled",
          // Persist bookmaker odds snapshot from ESPN (best-effort)
          oddsJson: item.prediction.odds ? JSON.stringify(item.prediction.odds) : null,
          // Persist H2H + form from ESPN (only set when present, never overwrite with null)
          h2hJson,
          homeForm,
          awayForm,
        },
        update: {
          kickoffUtc: m.kickoffUtc,
          kickoffBrussels: m.kickoffBrussels,
          leagueId: league.id,
          oddsJson: item.prediction.odds ? JSON.stringify(item.prediction.odds) : null,
          // Update H2H + form when ESPN provides fresh data (don't null-out existing)
          ...(h2hJson ? { h2hJson } : {}),
          ...(homeForm ? { homeForm } : {}),
          ...(awayForm ? { awayForm } : {}),
        },
      });
      matchIdByExternalId.set(m.externalId, match.id);
      matchesStored++;

      // Store ESPN's per-source prediction (with REAL bookmaker odds)
      const payloadJson = JSON.stringify(item.prediction);
      const existingRaw = await db.rawPrediction.findFirst({
        where: { matchId: match.id, sourceId: source.id },
      });
      if (existingRaw) {
        await db.rawPrediction.update({
          where: { id: existingRaw.id },
          data: {
            payloadJson,
            predicted1X2: item.prediction["1x2"] ?? null,
            predictedScore: item.prediction.correctScore ?? null,
            predictedBTTS: item.prediction.btts ?? null,
            predictedOU25: item.prediction.ou25 ?? null,
          },
        });
      } else {
        await db.rawPrediction.create({
          data: {
            matchId: match.id,
            sourceId: source.id,
            payloadJson,
            predicted1X2: item.prediction["1x2"] ?? null,
            predictedScore: item.prediction.correctScore ?? null,
            predictedBTTS: item.prediction.btts ?? null,
            predictedOU25: item.prediction.ou25 ?? null,
          },
        });
        predictionsStored++;
      }
    }
  }

  // ─── Phase 2: attach picks from prediction-only sources ────────────────────
  // These don't create new matches; they only add RawPredictions for matches
  // that already exist (matched by externalId).
  const predictionOnlyResults = scrapeResults.filter(
    (sr) => !SOURCES.find((s) => s.name === sr.source)?.providesFixtures
  );

  for (const sr of predictionOnlyResults) {
    const source = await db.source.findUnique({ where: { name: sr.source } });
    if (!source) continue;
    await db.source.update({
      where: { id: source.id },
      data: { lastScrapedAt: new Date() },
    });

    for (const item of sr.matches) {
      const matchId = matchIdByExternalId.get(item.match.externalId);
      if (!matchId) continue; // skip — match not in today's ESPN fixtures

      const payloadJson = JSON.stringify(item.prediction);
      const existingRaw = await db.rawPrediction.findFirst({
        where: { matchId, sourceId: source.id },
      });
      if (existingRaw) {
        await db.rawPrediction.update({
          where: { id: existingRaw.id },
          data: {
            payloadJson,
            predicted1X2: item.prediction["1x2"] ?? null,
            predictedScore: item.prediction.correctScore ?? null,
            predictedBTTS: item.prediction.btts ?? null,
            predictedOU25: item.prediction.ou25 ?? null,
          },
        });
      } else {
        await db.rawPrediction.create({
          data: {
            matchId,
            sourceId: source.id,
            payloadJson,
            predicted1X2: item.prediction["1x2"] ?? null,
            predictedScore: item.prediction.correctScore ?? null,
            predictedBTTS: item.prediction.btts ?? null,
            predictedOU25: item.prediction.ou25 ?? null,
          },
        });
        predictionsStored++;
      }
    }
  }

  return {
    startedAt,
    finishedAt: new Date(),
    matchesStored,
    predictionsStored,
    results: scrapeResults,
  };
}

/**
 * Public helper for tests / manual triggers — returns the count of ESPN
 * leagues we cover.
 */
export function getEspnLeagueCount(): number {
  return ESPN_LEAGUE_COUNT;
}
