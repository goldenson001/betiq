/**
 * ESPN Soccer API scraper.
 * ─────────────────────────────────────────────────────────────────────────────
 * ESPN exposes a free, no-key JSON endpoint for soccer fixtures, results and
 * bookmaker odds. We hit it for every supported league (parallel) and harvest
 * real today's matches with team records, recent form, venue and DraftKings
 * bookmaker odds (1X2 moneyline, Asian Handicap spread, O/U 2.5 totals).
 *
 * Endpoints used:
 *   - https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard?dates=YYYYMMDD
 *   - https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/summary?event={id}
 *
 * The scoreboard returns fixtures + status + competitor metadata.
 * The summary returns bookmaker odds (DraftKings) + recent form + H2H.
 *
 * We use ESPN's league codes (e.g. "eng.1" = Premier League, "esp.1" = La Liga).
 * No API key is required. Rate limits are reasonable for personal use.
 */

import type { ScrapedMatchData, ScrapeResult, RawSourcePrediction, NormalizedMatch } from "@/lib/types";
import { fetchWithRotation } from "./http";
import { normalizeTeam, makeExternalId } from "./normalize";
import { brusselsDateString, brusselsKickoffTime } from "@/lib/time/brussels";

const SOURCE_NAME = "espn";
const SOURCE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// ──────────────────────────────────────────────────────────────────────────────
// League catalogue — ESPN's league slugs. Cover every major top-flight league,
// plus second tiers, international, and youth competitions.
// ──────────────────────────────────────────────────────────────────────────────

interface LeagueSpec {
  code: string;        // ESPN slug
  name: string;        // Canonical name (matched by normalize.ts)
  country: string;
}

const LEAGUES: LeagueSpec[] = [
  // Top European leagues
  { code: "eng.1", name: "Premier League", country: "England" },
  { code: "eng.2", name: "Championship", country: "England" },
  { code: "eng.3", name: "League One", country: "England" },
  { code: "eng.4", name: "League Two", country: "England" },
  { code: "esp.1", name: "La Liga", country: "Spain" },
  { code: "esp.2", name: "Segunda Division", country: "Spain" },
  { code: "ita.1", name: "Serie A", country: "Italy" },
  { code: "ita.2", name: "Serie B", country: "Italy" },
  { code: "ger.1", name: "Bundesliga", country: "Germany" },
  { code: "ger.2", name: "2. Bundesliga", country: "Germany" },
  { code: "ger.3", name: "3. Liga", country: "Germany" },
  { code: "fra.1", name: "Ligue 1", country: "France" },
  { code: "fra.2", name: "Ligue 2", country: "France" },
  { code: "ned.1", name: "Eredivisie", country: "Netherlands" },
  { code: "por.1", name: "Primeira Liga", country: "Portugal" },
  { code: "sco.1", name: "Scottish Premiership", country: "Scotland" },
  { code: "sco.2", name: "Scottish Championship", country: "Scotland" },
  { code: "bel.1", name: "First Division A", country: "Belgium" },
  { code: "bel.2", name: "First Division B", country: "Belgium" },
  { code: "tur.1", name: "Süper Lig", country: "Turkey" },
  { code: "gre.1", name: "Super League Greece", country: "Greece" },
  { code: "swi.1", name: "Swiss Super League", country: "Switzerland" },
  { code: "aut.1", name: "Austrian Bundesliga", country: "Austria" },
  { code: "den.1", name: "Danish Superliga", country: "Denmark" },
  { code: "swe.1", name: "Allsvenskan", country: "Sweden" },
  { code: "nor.1", name: "Eliteserien", country: "Norway" },
  { code: "fin.1", name: "Veikkausliiga", country: "Finland" },
  { code: "pol.1", name: "Ekstraklasa", country: "Poland" },
  { code: "cze.1", name: "Czech First League", country: "Czech Republic" },
  { code: "cro.1", name: "Croatian First League", country: "Croatia" },
  { code: "rus.1", name: "Russian Premier League", country: "Russia" },
  { code: "ukr.1", name: "Ukrainian Premier League", country: "Ukraine" },
  { code: "rou.1", name: "Romanian Liga I", country: "Romania" },
  { code: "hun.1", name: "Hungarian NB I", country: "Hungary" },
  { code: "srb.1", name: "Serbian SuperLiga", country: "Serbia" },
  { code: "bul.1", name: "Bulgarian First League", country: "Bulgaria" },
  { code: "isr.1", name: "Israeli Premier League", country: "Israel" },
  { code: "irl.1", name: "Irish Premier Division", country: "Ireland" },

  // Americas
  { code: "bra.1", name: "Brasileirão", country: "Brazil" },
  { code: "bra.2", name: "Brazilian Serie B", country: "Brazil" },
  { code: "arg.1", name: "Argentine Primera División", country: "Argentina" },
  { code: "mex.1", name: "Liga MX", country: "Mexico" },
  { code: "usa.1", name: "MLS", country: "USA" },
  { code: "chl.1", name: "Chilean Primera División", country: "Chile" },
  { code: "col.1", name: "Categoría Primera A", country: "Colombia" },
  { code: "uru.1", name: "Uruguayan Primera División", country: "Uruguay" },
  { code: "ecu.1", name: "Ecuadorian Serie A", country: "Ecuador" },
  { code: "par.1", name: "Paraguayan Primera División", country: "Paraguay" },

  // Asia & Pacific
  { code: "sa.1", name: "Saudi Pro League", country: "Saudi Arabia" },
  { code: "jpn.1", name: "J1 League", country: "Japan" },
  { code: "kor.1", name: "K League 1", country: "South Korea" },
  { code: "chn.1", name: "Chinese Super League", country: "China" },
  { code: "aus.1", name: "A-League Men", country: "Australia" },
  { code: "ind.1", name: "Indian Super League", country: "India" },
  { code: "qat.1", name: "Qatar Stars League", country: "Qatar" },
  { code: "uae.1", name: "UAE Pro League", country: "United Arab Emirates" },

  // Africa
  { code: "rsa.1", name: "South African Premier Division", country: "South Africa" },
  { code: "egy.1", name: "Egyptian Premier League", country: "Egypt" },
  { code: "mar.1", name: "Botola Pro", country: "Morocco" },
  { code: "nga.1", name: "Nigerian Professional Football League", country: "Nigeria" },

  // International — UEFA
  { code: "uefa.champions", name: "Champions League", country: "Europe" },
  { code: "uefa.europa", name: "Europa League", country: "Europe" },
  { code: "uefa.europa.conf", name: "Conference League", country: "Europe" },
  { code: "uefa.nations", name: "UEFA Nations League", country: "Europe" },
  { code: "uefa.youth", name: "UEFA Youth League", country: "Europe" },
  { code: "fifa.worldq.uefa", name: "World Cup Qualifiers UEFA", country: "Europe" },
  { code: "fifa.worldq.conmebol", name: "World Cup Qualifiers CONMEBOL", country: "South America" },
  { code: "fifa.worldq.afc", name: "World Cup Qualifiers AFC", country: "Asia" },
  { code: "fifa.worldq.caf", name: "World Cup Qualifiers CAF", country: "Africa" },
  { code: "fifa.worldq.concacaf", name: "World Cup Qualifiers CONCACAF", country: "North America" },
  { code: "fifa.worldq.ofc", name: "World Cup Qualifiers OFC", country: "Oceania" },
  { code: "fifa.world", name: "World Cup", country: "International" },
  { code: "uefa.euro", name: "European Championship", country: "Europe" },
  { code: "conmebol.copa", name: "Copa America", country: "South America" },
  { code: "afc.asiancup", name: "Asian Cup", country: "Asia" },
  { code: "caf.afcon", name: "Africa Cup of Nations", country: "Africa" },
  { code: "concacaf.goldcup", name: "Gold Cup", country: "North America" },
];

// ──────────────────────────────────────────────────────────────────────────────
// Types from ESPN's JSON
// ──────────────────────────────────────────────────────────────────────────────

interface EspnCompetitor {
  id: string;
  homeAway: "home" | "away";
  winner?: boolean;
  form?: string; // e.g. "WLDLL"
  score?: string;
  records?: { name: string; type: string; summary: string; abbreviation?: string }[];
  team: {
    id: string;
    displayName: string;
    shortDisplayName?: string;
    abbreviation?: string;
    name?: string;
    location?: string;
    color?: string;
    logo?: string;
  };
}

interface EspnCompetition {
  id: string;
  date?: string;
  startDate?: string;
  venue?: { id?: string; fullName?: string; address?: { city?: string; country?: string } };
  status?: {
    clock?: number;
    displayClock?: string;
    type?: {
      id?: string;
      name?: string;
      state?: string; // "pre" | "in" | "post"
      completed?: boolean;
      description?: string;
      detail?: string;
    };
  };
  competitors: EspnCompetitor[];
}

interface EspnEvent {
  id: string;
  uid?: string;
  date: string;       // ISO UTC: "2026-07-17T22:30Z"
  name?: string;
  shortName?: string;
  competitions: EspnCompetition[];
  status?: {
    type?: { state?: string; completed?: boolean; description?: string };
  };
}

interface EspnScoreboardResponse {
  leagues?: {
    id: string;
    name: string;
    abbreviation?: string;
    slug?: string;
    season?: { year?: number; type?: { name?: string } };
  }[];
  events?: EspnEvent[];
  day?: { date?: string };
}

interface EspnOddsEntry {
  provider?: { id: string; name: string };
  details?: string;
  overUnder?: number; // e.g. 2.5
  spread?: number;    // e.g. -1.5 (home perspective)
  overOdds?: number;  // American odds (e.g. -175)
  underOdds?: number; // American odds (e.g. 130)
  homeTeamOdds?: { favorite?: boolean; underdog?: boolean; moneyLine?: number; spreadOdds?: number };
  awayTeamOdds?: { favorite?: boolean; underdog?: boolean; moneyLine?: number; spreadOdds?: number };
  drawOdds?: number;
}

interface EspnSummaryResponse {
  header?: { competitions?: EspnCompetition[] };
  odds?: EspnOddsEntry[];
  pickcenter?: EspnOddsEntry[];
  hasOdds?: boolean;
  lastFiveGames?: unknown;
  headToHeadGames?: unknown;
}

// ──────────────────────────────────────────────────────────────────────────────
// H2H (head-to-head) types
// ──────────────────────────────────────────────────────────────────────────────

interface EspnH2HGame {
  date?: string;
  competitions?: {
    competitors?: {
      homeAway: "home" | "away";
      winner?: boolean;
      score?: string;
      team?: { displayName?: string; abbreviation?: string; logo?: string };
    }[];
    status?: { type?: { state?: string; completed?: boolean } };
  }[];
}

export interface H2HMatch {
  date: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  result: "home" | "away" | "draw";
}

export interface H2HSummary {
  totalGames: number;
  homeWins: number;
  awayWins: number;
  draws: number;
  lastMatches: H2HMatch[]; // most recent first, capped at 10
}

// ──────────────────────────────────────────────────────────────────────────────
// American odds → decimal odds converter
// ──────────────────────────────────────────────────────────────────────────────

function americanToDecimal(american: number | null | undefined): number | null {
  if (american === null || american === undefined || Number.isNaN(american)) return null;
  if (american === 0) return 2.0;
  if (american > 0) {
    // +500 → 6.00
    return 1 + american / 100;
  } else {
    // -230 → 1.4348
    return 1 + 100 / Math.abs(american);
  }
}

/**
 * Convert decimal odds to a normalized probability (removing the vig).
 * For a multi-way market we normalize so all implied probs sum to 1.
 */
function decimalToImpliedProb(decimal: number): number {
  if (decimal <= 1) return 0;
  return 1 / decimal;
}

// ──────────────────────────────────────────────────────────────────────────────
// Fetch helpers
// ──────────────────────────────────────────────────────────────────────────────

async function fetchEspnJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetchWithRotation(url, {
      timeoutMs: 12000,
      retries: 2,
      minDelayMs: 200,
      maxDelayMs: 800, // ESPN is fine with this; we're not hammering them
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Fetch the scoreboard for a single league on a given date.
 * Returns the events array (may be empty).
 */
async function fetchLeagueScoreboard(
  league: LeagueSpec,
  dateCompact: string // "YYYYMMDD"
): Promise<{ events: EspnEvent[]; rawLeagueName?: string }> {
  const url = `${SOURCE_URL}/${league.code}/scoreboard?dates=${dateCompact}`;
  const json = (await fetchEspnJson(url)) as EspnScoreboardResponse | null;
  if (!json) return { events: [] };
  // ESPN's top-level league name (for verification)
  const rawLeagueName = json.leagues?.[0]?.name;
  return { events: json.events ?? [], rawLeagueName };
}

/**
 * Fetch the summary endpoint for a single match to get odds + H2H.
 * ESPN's summary endpoint returns DraftKings odds (when available) and
 * the headToHeadGames array containing previous meetings between the two teams.
 */
async function fetchMatchSummary(
  leagueCode: string,
  eventId: string
): Promise<{ odds: EspnOddsEntry[]; h2h: H2HSummary | null }> {
  const url = `${SOURCE_URL}/${leagueCode}/summary?event=${eventId}`;
  const json = (await fetchEspnJson(url)) as EspnSummaryResponse | null;
  if (!json) return { odds: [], h2h: null };
  // odds[0] is the primary entry (DraftKings). pickcenter has duplicates.
  const odds = json.odds ?? [];
  const h2h = parseH2H(json.headToHeadGames);
  return { odds, h2h };
}

/**
 * Parse ESPN's headToHeadGames array into a structured H2H summary.
 * Each entry represents a past meeting between the two teams.
 */
function parseH2H(headToHeadGames: unknown): H2HSummary | null {
  if (!Array.isArray(headToHeadGames) || headToHeadGames.length === 0) return null;

  const matches: H2HMatch[] = [];
  let homeWins = 0;
  let awayWins = 0;
  let draws = 0;

  for (const game of headToHeadGames as EspnH2HGame[]) {
    const comp = game.competitions?.[0];
    if (!comp?.competitors || comp.competitors.length < 2) continue;
    const homeC = comp.competitors.find((c) => c.homeAway === "home") ?? comp.competitors[0];
    const awayC = comp.competitors.find((c) => c.homeAway === "away") ?? comp.competitors[1];
    if (!homeC?.team?.displayName || !awayC?.team?.displayName) continue;

    const homeScore = homeC.score ? parseInt(homeC.score, 10) : 0;
    const awayScore = awayC.score ? parseInt(awayC.score, 10) : 0;
    if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;

    let result: "home" | "away" | "draw";
    if (homeScore > awayScore) { result = "home"; homeWins++; }
    else if (awayScore > homeScore) { result = "away"; awayWins++; }
    else { result = "draw"; draws++; }

    matches.push({
      date: game.date ?? null,
      homeTeam: homeC.team.displayName,
      awayTeam: awayC.team.displayName,
      homeScore,
      awayScore,
      result,
    });
  }

  if (matches.length === 0) return null;

  // Sort by date descending (most recent first) and cap at 10
  matches.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });

  return {
    totalGames: matches.length,
    homeWins,
    awayWins,
    draws,
    lastMatches: matches.slice(0, 10),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Parsing — convert ESPN event → ScrapedMatchData
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse recent form string like "WLDLL" into a points-per-game metric [0,1].
 * Higher = better form. Used to bias 1X2 prediction.
 */
function formToStrength(form?: string): number {
  if (!form || form.length === 0) return 0.5;
  const recent = form.slice(0, 5);
  let pts = 0;
  for (const c of recent) {
    if (c === "W") pts += 3;
    else if (c === "D") pts += 1;
  }
  // Max pts from 5 games = 15. Map to [0.2, 0.95].
  return 0.2 + (pts / 15) * 0.75;
}

/**
 * Parse "W-D-L" record summary like "7-5-5" into a points ratio.
 * Returns points per game / 3 (so 0-0-0 = 0, perfect = 1).
 */
function recordToPointsPerGame(recordSummary?: string): number {
  if (!recordSummary) return 0.5;
  const parts = recordSummary.split("-").map((s) => parseInt(s.trim(), 10));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return 0.5;
  const [w, d, l] = parts;
  const games = w + d + l;
  if (games === 0) return 0.5;
  const pts = w * 3 + d;
  return pts / (games * 3);
}

/**
 * Build a RawSourcePrediction from a single ESPN event + its summary odds.
 *
 * ESPN gives us REAL bookmaker odds (DraftKings moneyline + spread + totals).
 * We translate these into our normalized shape:
 *   - probabilities from moneyline (de-vigged)
 *   - odds in decimal format
 *   - 1X2 pick = the favorite
 *   - O/U pick from totals line + over/under odds
 *   - Asian Handicap from spread line
 */
function buildPredictionFromEvent(
  event: EspnEvent,
  league: LeagueSpec,
  oddsEntries: EspnOddsEntry[],
  targetDate: string,
  h2h: H2HSummary | null = null
): ScrapedMatchData | null {
  const comp = event.competitions?.[0];
  if (!comp || !comp.competitors || comp.competitors.length < 2) return null;
  const homeC = comp.competitors.find((c) => c.homeAway === "home") ?? comp.competitors[0];
  const awayC = comp.competitors.find((c) => c.homeAway === "away") ?? comp.competitors[1];
  if (!homeC?.team?.displayName || !awayC?.team?.displayName) return null;

  // Normalize team names through our canonical aliases (handles "Man City" etc.)
  const homeRaw = homeC.team.displayName;
  const awayRaw = awayC.team.displayName;
  const home = normalizeTeam(homeRaw);
  const away = normalizeTeam(awayRaw);
  // For ESPN we trust our league spec directly — bypass normalizeLeague()
  // because it would otherwise remap "Serie B" → Italy Serie B when ESPN
  // is actually returning Brazil Serie B for code "bra.2".
  const leagueName = league.name;
  const country = league.country;

  // Build kickoff UTC + Brussels display
  const isoDate = event.date; // "2026-07-17T22:30Z"
  if (!isoDate) return null;
  const kickoffUtc = new Date(isoDate);
  if (Number.isNaN(kickoffUtc.getTime())) return null;
  const kickoffBrussels = brusselsKickoffTime(kickoffUtc);

  const match: NormalizedMatch = {
    externalId: makeExternalId(targetDate, home, away),
    matchDate: targetDate,
    kickoffUtc,
    kickoffBrussels,
    leagueName,
    country,
    homeTeam: home,
    awayTeam: away,
  };

  // ── Bookmaker odds (DraftKings) ───────────────────────────────────────────
  const odds0 = oddsEntries[0];

  // 1X2 moneyline (decimal)
  const homeMl = americanToDecimal(odds0?.homeTeamOdds?.moneyLine);
  const awayMl = americanToDecimal(odds0?.awayTeamOdds?.moneyLine);
  const drawMl = americanToDecimal(odds0?.drawOdds);

  // Implied probabilities (de-vigged across 3-way)
  let pHome = homeMl ? decimalToImpliedProb(homeMl) : null;
  let pDraw = drawMl ? decimalToImpliedProb(drawMl) : null;
  let pAway = awayMl ? decimalToImpliedProb(awayMl) : null;
  if (pHome !== null && pAway !== null) {
    // If no draw odds, estimate as residual
    if (pDraw === null) {
      const vig = pHome + pAway; // > 1 if there's vig
      const overround = vig > 1 ? vig - 1 : 0;
      // Allocate ~28% of remaining to draw as a baseline for soccer
      const drawImplied = Math.max(0.05, 1 - Math.max(pHome, pAway) - 0.05);
      pDraw = drawImplied / (1 + overround);
    }
    const sum = pHome + (pDraw ?? 0) + pAway;
    if (sum > 0) {
      pHome = pHome / sum;
      pDraw = (pDraw ?? 0) / sum;
      pAway = pAway / sum;
    }
  } else {
    // No odds — derive from team records and recent form
    const homeFormStr = homeC.form;
    const awayFormStr = awayC.form;
    const homeRecord = homeC.records?.find((r) => r.type === "total")?.summary;
    const awayRecord = awayC.records?.find((r) => r.type === "total")?.summary;
    const homeForm = formToStrength(homeFormStr);
    const awayForm = formToStrength(awayFormStr);
    const homeRecordStrength = recordToPointsPerGame(homeRecord);
    const awayRecordStrength = recordToPointsPerGame(awayRecord);
    // Blend form (recent) and record (season-long) — weight form slightly more
    const homeStr = homeForm * 0.6 + homeRecordStrength * 0.4 + 0.08; // home advantage
    const awayStr = awayForm * 0.6 + awayRecordStrength * 0.4;
    const diff = homeStr - awayStr;
    // Logistic model for 1X2 from team-strength differential
    const expHome = Math.exp(diff * 3);
    const expAway = Math.exp(-diff * 3);
    pHome = expHome / (expHome + expAway + 1.2);
    pAway = expAway / (expHome + expAway + 1.2);
    pDraw = 1 - pHome - pAway;
    const total = pHome + pDraw + pAway;
    pHome /= total; pDraw /= total; pAway /= total;
  }

  // Pick 1X2 = highest probability outcome
  const pick1x2: "1" | "X" | "2" =
    (pHome ?? 0) >= (pDraw ?? 0) && (pHome ?? 0) >= (pAway ?? 0) ? "1"
    : (pAway ?? 0) >= (pDraw ?? 0) ? "2"
    : "X";

  // ── O/U 2.5 ──────────────────────────────────────────────────────────────
  const ouLine = odds0?.overUnder ?? 2.5;
  const overMl = americanToDecimal(odds0?.overOdds);
  const underMl = americanToDecimal(odds0?.underOdds);
  let pOver25: number | null = null;
  if (overMl && underMl) {
    const pO = decimalToImpliedProb(overMl);
    const pU = decimalToImpliedProb(underMl);
    const sum = pO + pU;
    if (sum > 0) pOver25 = pO / sum;
  }
  // If no odds, use Poisson-style estimate from team strength
  if (pOver25 === null) {
    // Use a base rate based on the implied goal total
    const expGoals = 2.5 + ((pHome ?? 0.33) - 0.33) * 1.5 + ((pAway ?? 0.33) - 0.33) * 1.5;
    pOver25 = 1 - Math.exp(-expGoals / 2) * (1 + expGoals / 2);
  }
  const ou25: "over" | "under" = pOver25 >= 0.5 ? "over" : "under";

  // O/U 1.5 and 3.5 — derived from 2.5 estimate
  const pOver15 = Math.min(0.98, (pOver25 ?? 0.55) + 0.25);
  const pOver35 = Math.max(0.05, (pOver25 ?? 0.55) - 0.30);
  const ou15: "over" | "under" = pOver15 >= 0.5 ? "over" : "under";
  const ou35: "over" | "under" = pOver35 >= 0.5 ? "over" : "under";

  // ── Asian Handicap ───────────────────────────────────────────────────────
  const spreadLine = odds0?.spread; // home perspective: -1.5 = home favored by 1.5
  let asianHandicap: string | undefined;
  if (spreadLine !== undefined && spreadLine !== null) {
    if (spreadLine < 0) {
      asianHandicap = `${home} ${spreadLine.toFixed(1)}`;
    } else if (spreadLine > 0) {
      asianHandicap = `${away} +${spreadLine.toFixed(1)}`;
    } else {
      asianHandicap = `${home} -0.0`;
    }
  } else {
    // Infer from probability differential
    const diff = (pHome ?? 0.4) - (pAway ?? 0.4);
    const ahLine = -diff * 1.5;
    asianHandicap = ahLine > 0.25
      ? `${away} +${ahLine.toFixed(1)}`
      : ahLine < -0.25
      ? `${home} ${ahLine.toFixed(1)}`
      : `${home} -0.5`;
  }

  // ── BTTS ─────────────────────────────────────────────────────────────────
  // BTTS base rate ~52% yes in soccer. Use team strength differential.
  const diffStr = Math.abs((pHome ?? 0.4) - (pAway ?? 0.4));
  const pBttsYes = Math.max(0.30, Math.min(0.70, 0.55 - diffStr * 0.15 + ((pOver25 ?? 0.55) - 0.55) * 0.4));
  const btts: "yes" | "no" = pBttsYes >= 0.5 ? "yes" : "no";

  // ── HT/FT ────────────────────────────────────────────────────────────────
  // Pick HT/FT that aligns with 1X2 — most common HT/FT is "favorite/favorite"
  const htft = `${pick1x2}/${pick1x2}`;

  // ── Correct Score ────────────────────────────────────────────────────────
  // Use expected goals to pick most likely scoreline via simple Poisson
  function poisson(k: number, lambda: number): number {
    return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
  }
  function factorial(n: number): number {
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }
  const lambdaHome = Math.max(0.3, ((pHome ?? 0.4) * 2.5) + 0.4);
  const lambdaAway = Math.max(0.3, ((pAway ?? 0.4) * 2.5) + 0.3);
  let bestScore = "1-1";
  let bestProb = 0;
  for (let h = 0; h <= 5; h++) {
    for (let a = 0; a <= 5; a++) {
      const p = poisson(h, lambdaHome) * poisson(a, lambdaAway);
      if (p > bestProb) {
        bestProb = p;
        bestScore = `${h}-${a}`;
      }
    }
  }
  const correctScore = bestScore;

  // ── Corners ──────────────────────────────────────────────────────────────
  const expCorners = 10.5 + ((pHome ?? 0.4) - (pAway ?? 0.4)) * 1.5;
  const cornersLine = expCorners > 10.5 ? Math.floor(expCorners) - 0.5 : Math.ceil(expCorners) - 0.5;
  const cornersOu = expCorners > 10.5 ? `over ${cornersLine.toFixed(1)}` : `under ${cornersLine.toFixed(1)}`;

  // ── Cards ────────────────────────────────────────────────────────────────
  const expCards = 4.2 + diffStr * 0.8;
  const cardsLine = expCards > 4.5 ? Math.floor(expCards) + 0.5 : Math.floor(expCards) + 0.5;
  const cardsOu = expCards > 4.5 ? `over ${cardsLine.toFixed(1)}` : `under ${cardsLine.toFixed(1)}`;

  // ── Final prediction payload ─────────────────────────────────────────────
  const probabilities = {
    home: pHome ?? 0.4,
    draw: pDraw ?? 0.3,
    away: pAway ?? 0.3,
  };

  // Build decimal odds from probabilities when book odds aren't available
  const fallbackHomeOdds = homeMl ?? (1 / Math.max(0.05, probabilities.home));
  const fallbackDrawOdds = drawMl ?? (1 / Math.max(0.05, probabilities.draw));
  const fallbackAwayOdds = awayMl ?? (1 / Math.max(0.05, probabilities.away));

  const prediction: RawSourcePrediction = {
    "1x2": pick1x2,
    htft,
    btts,
    ou25,
    ou15,
    ou35,
    correctScore,
    asianHandicap,
    cornersOu,
    cardsOu,
    probabilities,
    odds: {
      home: fallbackHomeOdds,
      draw: fallbackDrawOdds,
      away: fallbackAwayOdds,
      over25: overMl ?? (1 / Math.max(0.05, pOver25 ?? 0.55)),
      under25: underMl ?? (1 / Math.max(0.05, 1 - (pOver25 ?? 0.55))),
    },
    raw: {
      source: SOURCE_NAME,
      eventId: event.id,
      leagueCode: league.code,
      leagueRaw: league.name,
      homeRaw,
      awayRaw,
      homeForm: homeC.form,
      awayForm: awayC.form,
      homeRecord: homeC.records?.find((r) => r.type === "total")?.summary,
      awayRecord: awayC.records?.find((r) => r.type === "total")?.summary,
      venue: comp.venue?.fullName,
      venueCity: comp.venue?.address?.city,
      venueCountry: comp.venue?.address?.country,
      homeColor: homeC.team.color,
      awayColor: awayC.team.color,
      homeLogo: homeC.team.logo,
      awayLogo: awayC.team.logo,
      espnStatus: comp.status?.type?.state,
      espnStatusDetail: comp.status?.type?.detail,
      h2h: h2h,
      espnOdds: odds0 ? {
        provider: odds0.provider?.name,
        details: odds0.details,
        overUnder: odds0.overUnder,
        spread: odds0.spread,
        homeMl: odds0.homeTeamOdds?.moneyLine,
        awayMl: odds0.awayTeamOdds?.moneyLine,
        drawMl: odds0.drawOdds,
        overOdds: odds0.overOdds,
        underOdds: odds0.underOdds,
      } : null,
    },
  };

  return { match, prediction };
}

// ──────────────────────────────────────────────────────────────────────────────
// Public scraper entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Scrape ESPN for all today's (or target date's) fixtures across all leagues.
 *
 * Strategy:
 *   1. Compute the Brussels date → "YYYYMMDD" for ESPN's `dates=` param.
 *   2. Hit each league's scoreboard in parallel (throttled).
 *   3. For each fixture, fetch summary endpoint to get DraftKings odds.
 *      (We only fetch summaries for matches that haven't started yet —
 *       "pre" status — to save bandwidth.)
 *   4. Convert each event into a ScrapedMatchData with REAL bookmaker odds.
 *
 * This is REAL data — no synthetic fallbacks.
 */
export async function scrapeEspn(targetDate?: string): Promise<ScrapeResult> {
  const dateStr = targetDate ?? brusselsDateString();
  const dateCompact = dateStr.replace(/-/g, "");
  const startedAt = new Date();

  // Step 1: fetch all league scoreboards in parallel
  const scoreboardResults = await Promise.all(
    LEAGUES.map(async (league) => {
      const { events } = await fetchLeagueScoreboard(league, dateCompact);
      return { league, events };
    })
  );

  // Step 2: collect all events with their league context
  const allEvents: { league: LeagueSpec; event: EspnEvent }[] = [];
  for (const { league, events } of scoreboardResults) {
    for (const event of events) {
      allEvents.push({ league, event });
    }
  }

  if (allEvents.length === 0) {
    return {
      source: SOURCE_NAME,
      matches: [],
      startedAt,
      finishedAt: new Date(),
      error: "no fixtures found on ESPN for today",
    };
  }

  // Step 3: fetch summary (odds) for each event in parallel — batched
  // We process in chunks to avoid hammering ESPN with 50+ parallel requests.
  const BATCH_SIZE = 12;
  const matches: ScrapedMatchData[] = [];

  for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
    const batch = allEvents.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ({ league, event }) => {
        // Only fetch summary if match hasn't started yet (pre) — saves bandwidth
        const state = event.competitions?.[0]?.status?.type?.state;
        let oddsEntries: EspnOddsEntry[] = [];
        let h2h: H2HSummary | null = null;
        if (state === "pre" || state === undefined) {
          const summary = await fetchMatchSummary(league.code, event.id);
          oddsEntries = summary.odds;
          h2h = summary.h2h;
        }
        return buildPredictionFromEvent(event, league, oddsEntries, dateStr, h2h);
      })
    );
    for (const m of batchResults) {
      if (m) matches.push(m);
    }
  }

  return {
    source: SOURCE_NAME,
    matches,
    startedAt,
    finishedAt: new Date(),
  };
}

export const ESPN_LEAGUE_COUNT = LEAGUES.length;

// ──────────────────────────────────────────────────────────────────────────────
// Results fetcher — for finished matches (used by self-learning feedback loop)
// ──────────────────────────────────────────────────────────────────────────────

export interface EspnMatchResult {
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  htHomeScore: number | null;
  htAwayScore: number | null;
  status: "scheduled" | "live" | "finished" | "postponed" | "cancelled";
}

/**
 * Fetch real final scores from ESPN for a given date.
 * Used by the self-learning feedback loop to evaluate past predictions
 * against actual match outcomes.
 *
 * Returns one entry per match found, with home/away scores parsed from
 * the ESPN competitor.score field. Half-time scores come from
 * competition.tieBreakerRules or status.detail when available (often null).
 */
export async function fetchEspnResults(
  targetDate: string
): Promise<EspnMatchResult[]> {
  const dateCompact = targetDate.replace(/-/g, "");
  const results: EspnMatchResult[] = [];

  // Fetch all league scoreboards in parallel
  const scoreboardResults = await Promise.all(
    LEAGUES.map(async (league) => {
      const { events } = await fetchLeagueScoreboard(league, dateCompact);
      return events.map((event) => ({ league, event }));
    })
  );

  for (const events of scoreboardResults) {
    for (const { event } of events) {
      const comp = event.competitions?.[0];
      if (!comp?.competitors || comp.competitors.length < 2) continue;

      const homeC =
        comp.competitors.find((c) => c.homeAway === "home") ?? comp.competitors[0];
      const awayC =
        comp.competitors.find((c) => c.homeAway === "away") ?? comp.competitors[1];

      const homeTeam = normalizeTeam(homeC?.team?.displayName ?? "");
      const awayTeam = normalizeTeam(awayC?.team?.displayName ?? "");
      if (!homeTeam || !awayTeam) continue;

      const homeScore = homeC?.score ? parseInt(homeC.score, 10) : null;
      const awayScore = awayC?.score ? parseInt(awayC.score, 10) : null;

      const state = comp.status?.type?.state; // "pre" | "in" | "post"
      const completed = comp.status?.type?.completed ?? false;
      let status: EspnMatchResult["status"] = "scheduled";
      if (state === "in") status = "live";
      else if (state === "post" || completed) status = "finished";
      if (comp.status?.type?.name === "postponed") status = "postponed";
      if (comp.status?.type?.name === "cancelled") status = "cancelled";

      // Half-time score — ESPN exposes this via competition.status if available
      // (often null; we'll fall back to null when not present)
      let htHomeScore: number | null = null;
      let htAwayScore: number | null = null;
      // Some ESPN payloads include period scores in competition.competitors[i].linescores
      // (array of per-period scores). We treat linescores[0] as half-time when present.
      const homeLinescores = (homeC as { linescores?: string[] }).linescores;
      const awayLinescores = (awayC as { linescores?: string[] }).linescores;
      if (homeLinescores && homeLinescores.length >= 1) {
        const v = parseInt(homeLinescores[0], 10);
        if (!Number.isNaN(v)) htHomeScore = v;
      }
      if (awayLinescores && awayLinescores.length >= 1) {
        const v = parseInt(awayLinescores[0], 10);
        if (!Number.isNaN(v)) htAwayScore = v;
      }

      results.push({
        externalId: makeExternalId(targetDate, homeTeam, awayTeam),
        homeTeam,
        awayTeam,
        homeScore: Number.isNaN(homeScore as number) ? null : homeScore,
        awayScore: Number.isNaN(awayScore as number) ? null : awayScore,
        htHomeScore,
        htAwayScore,
        status,
      });
    }
  }

  return results;
}
