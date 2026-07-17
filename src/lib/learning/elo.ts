/**
 * Elo Team-Strength Ratings (A2)
 * ──────────────────────────────────
 * A bookmaker-independent team-strength model. Updated after every finished
 * match. Used as a prior in 1X2 prediction when tipster coverage is sparse
 * (lower leagues, cup games, early season).
 *
 * Standard Elo with:
 *   - K-factor = 20 (default; configurable via ENGINE_CONFIG.ELO_K)
 *   - Home-field advantage = +65 rating points (≈ 0.18 in probability)
 *   - Draw gets a half-update (standard practice for club soccer)
 *
 * Rating scale: ~1200-2200, mean ~1500 (like chess).
 *
 *   pHome = 1 / (1 + 10^((R_away + HFA - R_home) / 400))
 *
 * After a match:
 *   expected_home = 1 / (1 + 10^((R_away + HFA - R_home) / 400))
 *   actual_home   = 1.0 if home win, 0.5 if draw, 0.0 if away win
 *   R_home += K * (actual_home - expected_home)
 *   R_away -= K * (actual_home - expected_home)
 *
 * For new teams (no rating yet), seed at 1500.
 */

import { db } from "@/lib/db";
import { ENGINE_CONFIG } from "@/lib/config";

/** Default rating for teams with no history. */
export const DEFAULT_ELO = 1500;

/**
 * Compute the home-win probability implied by two Elo ratings.
 *
 *   pHome = 1 / (1 + 10^((R_away + HFA - R_home) / 400))
 *
 * The home-field advantage is added to the home rating before computing
 * the differential.
 */
export function eloProbabilityHome(rHome: number, rAway: number): number {
  const hfa = ENGINE_CONFIG.ELO_HOME_ADVANTAGE;
  const diff = (rAway - (rHome + hfa)) / 400;
  // Clamp diff to avoid floating-point overflow in extreme cases
  const clampedDiff = Math.max(-8, Math.min(8, diff));
  return 1 / (1 + Math.pow(10, clampedDiff));
}

/**
 * Expected score for the home team (1.0 = certain win, 0.5 = draw, 0.0 = loss).
 * Same formula as eloProbabilityHome but interpreted as expected points.
 */
function expectedHome(rHome: number, rAway: number): number {
  return eloProbabilityHome(rHome, rAway);
}

/**
 * Actual score for the home team given the match result.
 *   home win  → 1.0
 *   draw      → 0.5
 *   away win  → 0.0
 */
function actualHome(homeScore: number, awayScore: number): number {
  if (homeScore > awayScore) return 1.0;
  if (homeScore < awayScore) return 0.0;
  return 0.5;
}

/**
 * Update Elo ratings for all finished matches on a given date that haven't
 * been processed yet (i.e., matches with resultProcessed = true but whose
 * TeamRating rows haven't been updated for this match).
 *
 * Idempotent: we use a ModelState key per match to avoid double-updating if
 * the feedback loop runs twice.
 *
 * NOTE: Team names must match across matches — we use the lowercased team
 * name as the key (no team ID resolution yet). If a team plays in multiple
 * leagues, we use the (teamName, leagueId) pair.
 */
export async function updateEloRatingsForDate(dateStr: string): Promise<{
  matchesProcessed: number;
  teamsUpdated: number;
}> {
  const matches = await db.match.findMany({
    where: {
      matchDate: dateStr,
      resultProcessed: true,
      homeScore: { not: null },
      awayScore: { not: null },
    },
    include: { league: true },
  });

  const K = ENGINE_CONFIG.ELO_K;
  let teamsUpdated = 0;
  let matchesProcessed = 0;

  for (const m of matches) {
    if (m.homeScore === null || m.awayScore === null) continue;
    // Idempotency check: skip if we've already updated Elo for this match
    const processedKey = `elo_processed_${m.id}`;
    const already = await db.modelState.findUnique({ where: { key: processedKey } });
    if (already) continue;

    const homeName = m.homeTeam.toLowerCase().trim();
    const awayName = m.awayTeam.toLowerCase().trim();
    // Use "none" sentinel when leagueId is null (Prisma compound key requires non-null).
    const leagueId = m.leagueId ?? "none";

    // Load or seed ratings
    const homeRating = await getOrCreateRating(homeName, leagueId);
    const awayRating = await getOrCreateRating(awayName, leagueId);

    // Compute update
    const expected = expectedHome(homeRating.rating, awayRating.rating);
    const actual = actualHome(m.homeScore, m.awayScore);
    const delta = K * (actual - expected);

    const newHomeRating = homeRating.rating + delta;
    const newAwayRating = awayRating.rating - delta;

    // Update form strings
    const newHomeForm = updateForm(homeRating.form, actual > 0.75 ? "W" : actual < 0.25 ? "L" : "D");
    const newAwayForm = updateForm(awayRating.form, actual < 0.25 ? "W" : actual > 0.75 ? "L" : "D");

    await db.teamRating.upsert({
      where: { teamName_leagueId: { teamName: homeName, leagueId } },
      create: {
        teamName: homeName,
        leagueId,
        rating: newHomeRating,
        matches: homeRating.matches + 1,
        form: newHomeForm,
      },
      update: {
        rating: newHomeRating,
        matches: homeRating.matches + 1,
        form: newHomeForm,
      },
    });

    await db.teamRating.upsert({
      where: { teamName_leagueId: { teamName: awayName, leagueId } },
      create: {
        teamName: awayName,
        leagueId,
        rating: newAwayRating,
        matches: awayRating.matches + 1,
        form: newAwayForm,
      },
      update: {
        rating: newAwayRating,
        matches: awayRating.matches + 1,
        form: newAwayForm,
      },
    });

    teamsUpdated += 2;
    matchesProcessed++;

    // Mark this match as Elo-processed
    await db.modelState.upsert({
      where: { key: processedKey },
      create: { key: processedKey, value: 1, notes: m.id },
      update: { value: 1, notes: m.id },
    });
  }

  return { matchesProcessed, teamsUpdated };
}

/**
 * Load a team's rating, seeding at DEFAULT_ELO if no history exists.
 */
async function getOrCreateRating(
  teamName: string,
  leagueId: string
): Promise<{ rating: number; matches: number; form: string | null }> {
  const row = await db.teamRating.findUnique({
    where: { teamName_leagueId: { teamName, leagueId } },
  });
  if (row) {
    return { rating: row.rating, matches: row.matches, form: row.form };
  }
  return { rating: DEFAULT_ELO, matches: 0, form: null };
}

/**
 * Append a W/D/L character to a form string, keeping the last 5.
 */
function updateForm(existing: string | null, result: "W" | "D" | "L"): string {
  const base = existing ?? "";
  return (base + result).slice(-5);
}

/**
 * Load Elo ratings for two teams and compute the home-win probability.
 * Returns null if neither team has a rating (i.e., no history).
 */
export async function loadEloProbability(
  homeTeam: string,
  awayTeam: string,
  leagueId: string | null | undefined
): Promise<{ pHome: number; pDraw: number; pAway: number; sampleSize: number } | null> {
  const homeName = homeTeam.toLowerCase().trim();
  const awayName = awayTeam.toLowerCase().trim();
  // Use "none" sentinel when leagueId is null
  const lid = leagueId ?? "none";

  const [homeRating, awayRating] = await Promise.all([
    db.teamRating.findUnique({
      where: { teamName_leagueId: { teamName: homeName, leagueId: lid } },
    }),
    db.teamRating.findUnique({
      where: { teamName_leagueId: { teamName: awayName, leagueId: lid } },
    }),
  ]);

  // If neither team has a rating, return null (no signal)
  if (!homeRating && !awayRating) return null;

  const rHome = homeRating?.rating ?? DEFAULT_ELO;
  const rAway = awayRating?.rating ?? DEFAULT_ELO;
  const sampleSize = (homeRating?.matches ?? 0) + (awayRating?.matches ?? 0);

  const pHome = eloProbabilityHome(rHome, rAway);
  // Approximate draw probability — empirically draw rate is ~25-28% in soccer,
  // and scales slightly with rating closeness.
  const ratingDiff = Math.abs(rHome - rAway);
  const pDraw = 0.26 + Math.max(-0.05, Math.min(0.04, (200 - ratingDiff) / 4000));
  const pAway = 1 - pHome - pDraw;

  return { pHome, pDraw, pAway, sampleSize };
}
