/**
 * GET /api/scores/live
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight live-score refresh endpoint.
 *
 * Hits ESPN's scoreboard API for the given Brussels date, updates match rows
 * (homeScore / awayScore / htHomeScore / htAwayScore / status) in the DB, and
 * returns:
 *   - The list of matches with their freshest score + status
 *   - Per-parlay per-leg live status (won | lost | pending) computed from the
 *     current scores (so the UI can show in-play parlay progress)
 *   - Counts: how many matches are live / finished / scheduled right now
 *   - lastUpdated timestamp
 *
 * This endpoint deliberately does NOT re-run scrapers, predictions or the
 * feedback loop. It is meant to be polled every ~30s by the dashboard so that
 * in-play score updates land in the UI within ~30s of ESPN publishing them.
 *
 * Query: date=YYYY-MM-DD (default: today Brussels)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { brusselsDateString } from "@/lib/time/brussels";
import { fetchEspnResults, type EspnMatchResult } from "@/lib/scrapers/espn";
import { evaluatePrediction } from "@/lib/learning/feedback";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface MatchScoreView {
  id: string;
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  kickoffBrussels: string | null;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  htHomeScore: number | null;
  htAwayScore: number | null;
  leagueId: string | null;
  leagueName: string | null;
  leagueCountry: string | null;
}

interface ParlayLegLiveStatus {
  predictionId: string;
  matchId: string;
  matchLabel: string;
  market: string;
  selection: string;
  /** won = leg has already been mathematically decided (lost or won). */
  decided: boolean;
  /** True only if the leg is decided AND won. False if lost OR still pending. */
  won: boolean;
  /** True if the leg's match is still in play (not yet decided). */
  pending: boolean;
  /** Live status of the underlying match: live | finished | scheduled | postponed | cancelled */
  matchStatus: string;
  homeScore: number | null;
  awayScore: number | null;
}

interface ParlayLiveView {
  id: string;
  type: string;
  legsCount: number;
  /** Aggregated leg-level status from current live scores. */
  legsWon: number;
  legsLost: number;
  legsPending: number;
  /** If any leg has lost, the parlay is dead. */
  busted: boolean;
  /** If all legs are decided and none lost, the parlay has won. */
  won: boolean;
  /** True if at least one leg's match is currently live. */
  hasLiveLeg: boolean;
  legs: ParlayLegLiveStatus[];
}

interface ScoresLiveResponse {
  ok: boolean;
  date: string;
  lastUpdated: string;
  counts: {
    total: number;
    live: number;
    finished: number;
    scheduled: number;
    postponed: number;
    cancelled: number;
  };
  matches: MatchScoreView[];
  parlays: ParlayLiveView[];
  /** True if ESPN was actually queried (false = fallback to DB only, e.g. on error). */
  espnPolled: boolean;
  error?: string;
}

export async function GET(req: NextRequest): Promise<NextResponse<ScoresLiveResponse>> {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") ?? brusselsDateString();

  // ── Step 1: Fetch live scores from ESPN ─────────────────────────────────
  let espnResults: EspnMatchResult[] = [];
  let espnPolled = false;
  let espnError: string | undefined;
  try {
    espnResults = await fetchEspnResults(date);
    espnPolled = true;
  } catch (err) {
    // Don't fail the whole request — fall back to whatever the DB already has.
    espnError = err instanceof Error ? err.message : String(err);
  }

  const byExternalId = new Map(espnResults.map((r) => [r.externalId, r]));

  // ── Step 2: Update match rows in DB with fresh scores ──────────────────
  // Only update matches that ESPN returned a result for. This way, if ESPN
  // fails for one league the others still get updated, and matches that ESPN
  // doesn't know about are left untouched.
  const matches = await db.match.findMany({
    where: { matchDate: date },
    include: { league: true },
  });

  for (const m of matches) {
    const espn = byExternalId.get(m.externalId);
    if (!espn) continue;
    // Determine if there's anything to update
    const needsUpdate =
      m.homeScore !== espn.homeScore ||
      m.awayScore !== espn.awayScore ||
      m.htHomeScore !== espn.htHomeScore ||
      m.htAwayScore !== espn.htAwayScore ||
      (m.status !== espn.status && espn.status !== "scheduled");
    if (!needsUpdate) continue;

    await db.match.update({
      where: { id: m.id },
      data: {
        homeScore: espn.homeScore,
        awayScore: espn.awayScore,
        htHomeScore: espn.htHomeScore,
        htAwayScore: espn.htAwayScore,
        status: espn.status,
      },
    });
  }

  // ── Step 3: Build response payload (matches + parlay live status) ───────
  // Re-read matches after the update to make sure we send the freshest values
  // back to the client (rather than the pre-update in-memory copies).
  const freshMatches = await db.match.findMany({
    where: { matchDate: date },
    include: { league: true },
    orderBy: { kickoffUtc: "asc" },
  });

  const matchById = new Map(freshMatches.map((m) => [m.id, m]));

  const matchViews: MatchScoreView[] = freshMatches.map((m) => ({
    id: m.id,
    externalId: m.externalId,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    kickoffBrussels: m.kickoffBrussels,
    status: m.status,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    htHomeScore: m.htHomeScore,
    htAwayScore: m.htAwayScore,
    leagueId: m.league?.id ?? null,
    leagueName: m.league?.name ?? null,
    leagueCountry: m.league?.country ?? null,
  }));

  // ── Parlay leg live status ─────────────────────────────────────────────
  const parlays = await db.parlay.findMany({
    where: { matchDate: date },
    orderBy: { type: "asc" },
  });

  const parlayViews: ParlayLiveView[] = parlays.map((p) => {
    let legs: Array<{
      predictionId: string;
      matchId: string;
      matchLabel: string;
      market: string;
      selection: string;
    }> = [];
    try {
      legs = JSON.parse(p.legsJson);
    } catch {
      legs = [];
    }

    const legStatuses: ParlayLegLiveStatus[] = legs.map((leg) => {
      const m = matchById.get(leg.matchId);
      const matchStatus = m?.status ?? "scheduled";
      const homeScore = m?.homeScore ?? null;
      const awayScore = m?.awayScore ?? null;
      const hasScore = homeScore !== null && awayScore !== null;

      // ── Decide the leg only if the match is finished (or postponed/cancelled) ──
      // For in-play matches, even if the current score would settle the market
      // (e.g. a 1X2 selection can already be known at 70' if one side is up 5-0),
      // we still treat the leg as "pending" — the official result only lands at FT.
      let decided = false;
      let won = false;
      if (hasScore && (matchStatus === "finished" || matchStatus === "postponed" || matchStatus === "cancelled")) {
        decided = true;
        if (matchStatus === "finished") {
          won = evaluatePrediction(
            { market: leg.market, selection: leg.selection },
            {
              homeScore,
              awayScore,
              htHomeScore: m?.htHomeScore ?? undefined,
              htAwayScore: m?.htAwayScore ?? undefined,
              corners: m?.corners ?? undefined,
              cards: m?.cards ?? undefined,
            },
            m?.homeTeam,
            m?.awayTeam
          );
        } else {
          won = false; // postponed/cancelled
        }
      }

      return {
        predictionId: leg.predictionId,
        matchId: leg.matchId,
        matchLabel: leg.matchLabel,
        market: leg.market,
        selection: leg.selection,
        decided,
        won,
        pending: !decided,
        matchStatus,
        homeScore,
        awayScore,
      };
    });

    const legsWon = legStatuses.filter((l) => l.decided && l.won).length;
    const legsLost = legStatuses.filter((l) => l.decided && !l.won).length;
    const legsPending = legStatuses.filter((l) => !l.decided).length;
    const hasLiveLeg = legStatuses.some((l) => l.matchStatus === "live");
    const busted = legsLost > 0;
    const allDecided = legsPending === 0 && legs.length > 0;
    const parlayWon = allDecided && !busted;

    return {
      id: p.id,
      type: p.type,
      legsCount: p.legsCount,
      legsWon,
      legsLost,
      legsPending,
      busted,
      won: parlayWon,
      hasLiveLeg,
      legs: legStatuses,
    };
  });

  // ── Counts ─────────────────────────────────────────────────────────────
  const counts = {
    total: matchViews.length,
    live: matchViews.filter((m) => m.status === "live").length,
    finished: matchViews.filter((m) => m.status === "finished").length,
    scheduled: matchViews.filter((m) => m.status === "scheduled").length,
    postponed: matchViews.filter((m) => m.status === "postponed").length,
    cancelled: matchViews.filter((m) => m.status === "cancelled").length,
  };

  return NextResponse.json({
    ok: true,
    date,
    lastUpdated: new Date().toISOString(),
    counts,
    matches: matchViews,
    parlays: parlayViews,
    espnPolled,
    error: espnError,
  });
}
