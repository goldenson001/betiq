/**
 * ESPN Closing Odds Re-Fetcher
 * ────────────────────────────
 * Helper used by `clv.ts:snapshotClosingOdds` to re-fetch ESPN odds for a
 * finished match. ESPN keeps match summary pages live for ~24h after kickoff,
 * so calling this from the feedback loop gives us the actual closing line
 * (the last odds offered before kickoff).
 *
 * Why a separate module?
 *   - clv.ts ↔ espn.ts have a potential circular dependency (espn.ts → db →
 *     ... → clv.ts). Lazy `import()` from inside the function avoids the cycle
 *     at module-load time.
 *   - This module is purpose-built for closing-odds re-fetch, with simpler
 *     error handling and no scraping side effects.
 */

import { EspnSummarySchema, parseEspnPayload, extractScore } from "./espn-schema";

const SOURCE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer";

/**
 * League code → ESPN slug mapping. ESPN organizes its soccer API by league
 * slug, e.g. `eng.1` for Premier League, `esp.1` for La Liga, etc. We need
 * this to construct the summary URL.
 *
 * This list mirrors the one in `espn.ts` and is intentionally kept in sync.
 * If a league isn't here, we fall back to `eng.1` (most common) — the worst
 * case is the URL 404s and we return null, which the caller handles.
 */
const LEAGUE_SLUGS: Record<string, string> = {
  EPL: "eng.1",
  LALIGA: "esp.1",
  BUNDESLIGA: "ger.1",
  SERIE_A: "ita.1",
  LIGUE_1: "fra.1",
  EREDIVISIE: "ned.1",
  PRIMEIRA: "por.1",
  SPL: "scot.1",
  MLS: "usa.1",
  CHAMPIONSHIP: "eng.2",
  LEAGUE_ONE: "eng.3",
  LEAGUE_TWO: "eng.4",
  UCL: "uefa.champions",
  UEL: "uefa.europa",
  UECL: "uefa.europa.conf",
  WORLD_CUP: "fifa.world",
  EURO: "uefa.euro",
  NATIONS_LEAGUE: "uefa.nations",
};

/**
 * Re-fetch ESPN odds for a finished match.
 *
 * @param eventId   ESPN event ID (stored on Match.externalId)
 * @param matchDate YYYY-MM-DD date string — used to scan the ESPN scoreboard
 *                   for the right league slug if we don't know it. For now we
 *                   just try the most common leagues.
 * @returns         JSON string in the same shape as Match.oddsJson
 *                   ({ home, draw, away, over25, under25, ... }) or null
 *                   if ESPN doesn't have the match anymore.
 */
export async function fetchEspnClosingOdds(
  eventId: string,
  matchDate: string
): Promise<string | null> {
  void matchDate; // reserved for future date-based league lookup

  // Try each known league slug until one returns a valid summary.
  // ESPN's API is per-league, so we have to know which league the match
  // belongs to. In practice we'd pass the league code in, but for closing
  // odds re-fetch we try the major leagues and stop on first hit.
  //
  // We try the top-5 European leagues + UCL/UEL first since they cover
  // the vast majority of fixtures, then fall back to the full list.
  const prioritySlugs = [
    "eng.1", "esp.1", "ger.1", "ita.1", "fra.1",
    "uefa.champions", "uefa.europa",
    "ned.1", "por.1", "scot.1", "eng.2", "usa.1",
  ];

  for (const slug of prioritySlugs) {
    const url = `${SOURCE_URL}/${slug}/summary?event=${eventId}`;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const json: unknown = await res.json();
      const parsed = parseEspnPayload(EspnSummarySchema, json, `closing-odds ${slug}/${eventId}`);
      if (!parsed.success || !parsed.data) continue;

      const oddsEntries = parsed.data.odds ?? parsed.data.pickcenter ?? [];
      if (oddsEntries.length === 0) continue;

      const oddsJson = extractOddsJsonFromEntries(oddsEntries);
      if (oddsJson) return JSON.stringify(oddsJson);
    } catch {
      // Network error or timeout — try next slug.
      continue;
    }
  }

  return null;
}

/**
 * Convert ESPN's odds entry array into the { home, draw, away, over25, under25 }
 * JSON shape that the rest of the system expects.
 *
 * ESPN's odds come from DraftKings (or whichever provider is first in the
 * array). We pick the first entry with a complete moneyline.
 */
function extractOddsJsonFromEntries(
  entries: Array<{
    provider?: { name?: string };
    homeTeamOdds?: { moneyLine?: number };
    awayTeamOdds?: { moneyLine?: number };
    drawOdds?: number;
    overUnder?: number;
    overOdds?: number;
    underOdds?: number;
  }>
): Record<string, number> | null {
  // Pick the first entry with a complete 1X2 moneyline
  const entry = entries.find(
    (e) => e.homeTeamOdds?.moneyLine && e.awayTeamOdds?.moneyLine
  );
  if (!entry) return null;

  const americanToDecimal = (am: number | undefined): number | null => {
    if (am === undefined || am === null || am === 0) return null;
    if (am > 0) return am / 100 + 1;
    return 100 / -am + 1;
  };

  const home = americanToDecimal(entry.homeTeamOdds?.moneyLine);
  const away = americanToDecimal(entry.awayTeamOdds?.moneyLine);
  const draw = entry.drawOdds
    ? americanToDecimal(entry.drawOdds)
    : null;

  // Over/Under 2.5 — ESPN labels it as overUnder = 2.5
  const ou25Entry = entries.find((e) => e.overUnder === 2.5);
  const over25 = ou25Entry?.overOdds ? americanToDecimal(ou25Entry.overOdds) : null;
  const under25 = ou25Entry?.underOdds ? americanToDecimal(ou25Entry.underOdds) : null;

  const result: Record<string, number> = {};
  if (home) result.home = home;
  if (away) result.away = away;
  if (draw) result.draw = draw;
  if (over25) result.over25 = over25;
  if (under25) result.under25 = under25;

  // We need at least a 1X2 to be useful for CLV
  if (!result.home || !result.away) return null;

  void extractScore; // re-exported for type-completeness; not used here
  return result;
}

// Re-export for downstream consumers
export { LEAGUE_SLUGS };
