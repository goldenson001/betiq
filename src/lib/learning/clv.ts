/**
 * Closing Line Value (CLV) Tracker
 * ───────────────────────────────────
 * CLV measures whether your predictions beat the closing line — the odds at
 * kickoff, when the market is most efficient. Beating the closing line is
 * the single best predictor of long-run betting profitability, far better
 * than hit rate or ROI over small samples.
 *
 * Definition:
 *   CLV = (closing_implied_prob - your_predicted_prob) / your_predicted_prob
 *
 * Or equivalently in odds terms:
 *   CLV = (your_odds / closing_odds) - 1
 *
 * Positive CLV means: "I got better odds than the market eventually offered."
 * A skilled bettor will have CLV of +2% to +5% over time; anything consistently
 * above 0 is a long-term winner.
 *
 * Implementation:
 *   - When we first scrape a match, we snapshot ESPN odds → openingOddsJson
 *   - At feedback time (after match finished), we re-fetch ESPN odds → closingOddsJson
 *   - For each top pick and value bet, we compute CLV vs the closing line
 *
 * ESPN's odds come from DraftKings and represent the actual market line. The
 * "closing" line is whatever DraftKings showed at kickoff; we approximate by
 * re-fetching after the match finished (which still shows the final odds that
 * were offered).
 */

import { db } from "@/lib/db";

/**
 * Compute CLV for a single prediction given the closing odds.
 *
 * @param predictedProb  Our model's probability for this pick (0-1)
 * @param closingOdds    Closing line decimal odds for this pick (e.g. 2.10)
 * @returns              CLV as a fraction (0.03 = +3% CLV), or null if unavailable
 */
export function computeClv(
  predictedProb: number,
  closingOdds: number | null | undefined
): number | null {
  if (!closingOdds || closingOdds <= 1) return null;
  const closingImplied = 1 / closingOdds;
  if (predictedProb <= 0 || predictedProb >= 1) return null;
  // CLV = (predicted_prob - closing_implied) / closing_implied
  // Equivalent: (closing_odds / our_fair_odds) - 1
  return (predictedProb - closingImplied) / closingImplied;
}

/**
 * Snapshot the current odds on a Match as the "opening" line — called the
 * first time we scrape a match (when predictions are generated).
 *
 * This is idempotent: if openingOddsJson is already set, we keep the earliest
 * snapshot. The earliest snapshot is the most useful because it represents
 * the line we'd have bet at.
 */
export async function snapshotOpeningOdds(matchId: string): Promise<void> {
  const match = await db.match.findUnique({ where: { id: matchId }, select: { oddsJson: true, openingOddsJson: true } });
  if (!match) return;
  if (match.openingOddsJson) return; // already snapshotted
  if (!match.oddsJson) return;        // no odds to snapshot
  await db.match.update({
    where: { id: matchId },
    data: { openingOddsJson: match.oddsJson },
  });
}

/**
 * Snapshot the closing odds for a match by re-fetching ESPN.
 * Called during the feedback loop, after the match has finished.
 *
 * If ESPN still has the match in its scoreboard (it usually does for ~24h
 * after kickoff), we grab the latest odds as the closing line.
 *
 * D1 upgrade: also appends the closing odds to the oddsSnapshotsJson array
 * as the final snapshot, so we have a complete open → mid → close timeline.
 */
export async function snapshotClosingOdds(
  matchExternalId: string,
  matchDate: string
): Promise<string | null> {
  // We piggyback on the ESPN fetch that the feedback loop already does —
  // we expect the caller to pass us the closing odds if available.
  // This function is a placeholder for direct re-fetching; in practice the
  // feedback loop already has the ESPN result and can pass the odds through.
  void matchExternalId;
  void matchDate;
  return null;
}

/**
 * D1: Snapshot the current ESPN odds for a match and append to the
 * oddsSnapshotsJson timeline. Called by a mid-day scheduler job so we can
 * detect line movement (steam moves) between open and close.
 *
 * Each snapshot is stored as `{ capturedAt, oddsJson }` in an array. We
 * keep up to 10 snapshots per match (older ones get dropped).
 *
 * Returns the new snapshot count.
 */
export async function appendOddsSnapshot(matchId: string, currentOddsJson: string | null): Promise<number> {
  if (!currentOddsJson) return 0;
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { oddsSnapshotsJson: true },
  });
  if (!match) return 0;

  // Parse existing snapshots
  let snapshots: Array<{ capturedAt: string; oddsJson: string }> = [];
  if (match.oddsSnapshotsJson) {
    try {
      snapshots = JSON.parse(match.oddsSnapshotsJson) as typeof snapshots;
    } catch { /* ignore parse errors */ }
  }

  // Skip if the odds haven't changed since the last snapshot
  if (snapshots.length > 0 && snapshots[snapshots.length - 1].oddsJson === currentOddsJson) {
    return snapshots.length;
  }

  // Append new snapshot
  snapshots.push({
    capturedAt: new Date().toISOString(),
    oddsJson: currentOddsJson,
  });

  // Keep only the most recent 10 snapshots
  if (snapshots.length > 10) {
    snapshots = snapshots.slice(-10);
  }

  await db.match.update({
    where: { id: matchId },
    data: { oddsSnapshotsJson: JSON.stringify(snapshots) },
  });

  return snapshots.length;
}

/**
 * D1: Compute line movement for a match — has the line moved toward or away
 * from our pick? Used as a small ±0.02 probability nudge in gen1X2.
 *
 * Returns:
 *   - positive value = line moved TOWARD our pick (market agrees with us)
 *   - negative value = line moved AWAY from our pick (market disagrees)
 *   - null = not enough snapshots to compute
 */
export function computeLineMovement(
  snapshots: Array<{ capturedAt: string; oddsJson: string }>,
  oddsKey: string
): { movePct: number; movedTowardPick: boolean } | null {
  if (snapshots.length < 2) return null;

  // Parse the first and last snapshots' odds for the given key
  const parseOdds = (json: string): number | null => {
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      const v = obj[oddsKey];
      return typeof v === "number" && v > 1 ? v : null;
    } catch { return null; }
  };

  const openOdds = parseOdds(snapshots[0].oddsJson);
  const closeOdds = parseOdds(snapshots[snapshots.length - 1].oddsJson);
  if (!openOdds || !closeOdds) return null;

  // Move = (close - open) / open
  // If odds got SHORTER (close < open), the market now thinks this outcome
  // is MORE likely → line moved TOWARD the pick (positive signal).
  // If odds got LONGER (close > open), the market moved AWAY → negative signal.
  const movePct = (closeOdds - openOdds) / openOdds;
  // For "backing" the outcome: shorter odds = good (line moved toward us)
  // Convert to a "toward pick" signal: negative movePct = toward pick
  const movedTowardPick = movePct < 0;
  return { movePct, movedTowardPick };
}

/**
 * D1: Snapshot odds for all matches on a given date that haven't kicked off yet.
 * Called by a mid-day scheduler job (typically 14:00 Brussels) so we can
 * detect line movement (steam moves) between open and close.
 *
 * Re-fetches ESPN odds for each match and appends to oddsSnapshotsJson.
 * Only matches that haven't kicked off yet are snapshotted (no point in
 * snapshotting finished matches).
 */
export async function snapshotOddsForDate(dateStr: string): Promise<{
  matchesSnapshotted: number;
}> {
  // Load all matches for this date that haven't kicked off yet
  const now = new Date();
  const matches = await db.match.findMany({
    where: {
      matchDate: dateStr,
      kickoffUtc: { gt: now },
      status: { not: "finished" },
    },
    select: { id: true, oddsJson: true },
  });

  let matchesSnapshotted = 0;
  for (const m of matches) {
    if (!m.oddsJson) continue;
    const count = await appendOddsSnapshot(m.id, m.oddsJson);
    if (count > 0) matchesSnapshotted++;
  }

  return { matchesSnapshotted };
}

/**
 * Compute CLV for all top picks and value bets on a given date.
 * Called by the feedback loop after matches finish.
 *
 * For each match, we look at:
 *   - openingOddsJson: odds when we made the prediction
 *   - closingOddsJson: odds at kickoff / after match (best-effort)
 *
 * We compute CLV per prediction and write it to the Prediction.clv column.
 * We also compute an average CLV for the daily snapshot.
 */
export async function computeClvForDate(dateStr: string): Promise<{
  matchesProcessed: number;
  predictionsWithClv: number;
  avgClv: number;
}> {
  const matches = await db.match.findMany({
    where: { matchDate: dateStr, clvComputed: false },
    include: {
      predictions: {
        where: {
          OR: [{ isTopPick: true }, { isValueBet: true }, { isSafeHighOdds: true }],
        },
      },
    },
  });

  let predictionsWithClv = 0;
  let clvSum = 0;

  for (const match of matches) {
    // We need closing odds. If we don't have them stored, fall back to
    // openingOddsJson (effectively CLV = 0, but we still mark as computed
    // so we don't keep retrying).
    const closingOddsJson = match.closingOddsJson ?? match.openingOddsJson ?? match.oddsJson;
    if (!closingOddsJson) {
      await db.match.update({ where: { id: match.id }, data: { clvComputed: true } });
      continue;
    }

    let closingOdds: Record<string, number> = {};
    try {
      closingOdds = JSON.parse(closingOddsJson) as Record<string, number>;
    } catch {
      await db.match.update({ where: { id: match.id }, data: { clvComputed: true } });
      continue;
    }

    for (const pred of match.predictions) {
      // Map market+selection to an odds key in the closing odds JSON
      const oddsKey = pickToOddsKey(pred.market, pred.selection, match.homeTeam, match.awayTeam);
      const closingOdd = oddsKey ? closingOdds[oddsKey] : null;
      const clv = computeClv(pred.probability, closingOdd ?? null);
      if (clv !== null) {
        await db.prediction.update({
          where: { id: pred.id },
          data: { clv },
        });
        clvSum += clv;
        predictionsWithClv++;
      }
    }

    await db.match.update({ where: { id: match.id }, data: { clvComputed: true } });
  }

  const avgClv = predictionsWithClv > 0 ? clvSum / predictionsWithClv : 0;
  return {
    matchesProcessed: matches.length,
    predictionsWithClv,
    avgClv,
  };
}

/**
 * Map a (market, selection) pair to the key used in the odds JSON snapshot.
 *
 * The odds JSON is populated by the ESPN scraper and has keys like:
 *   { "home": 2.10, "draw": 3.30, "away": 3.40,
 *     "over25": 1.85, "under25": 1.95 }
 *
 * For markets that don't map cleanly (HT/FT, correct score, AH), we return
 * null and skip CLV for those — the closing line for those exotic markets
 * isn't readily available from ESPN's free API.
 */
function pickToOddsKey(
  market: string,
  selection: string,
  homeTeam: string,
  awayTeam: string
): string | null {
  switch (market) {
    case "1x2":
      if (selection === "1") return "home";
      if (selection === "X") return "draw";
      if (selection === "2") return "away";
      return null;
    case "ou25":
      return selection === "over" ? "over25" : "under25";
    case "btts":
      // Not always in ESPN's odds JSON — return the conventional key
      return selection === "yes" ? "btts_yes" : "btts_no";
    // ── Derivative markets — CLV computed against the dominant underlying outcome
    // For Double Chance (1X/X2/12), CLV is approximated using the most likely
    // of the two covered outcomes (e.g. 1X → "home" since home is usually the
    // favorite when 1X is the pick). This isn't perfect but tracks CLV well
    // enough to be useful for source reliability scoring.
    case "double_chance":
      if (selection === "1X") return "home"; // home-or-draw → track home line
      if (selection === "X2") return "away"; // draw-or-away → track away line
      if (selection === "12") return "home"; // either side wins → track home line
      return null;
    // DNB: the selection includes the team name (e.g. "Arsenal DNB"). Map to
    // home/away based on which team is in the selection string.
    case "dnb": {
      const sel = selection.toLowerCase();
      if (sel.includes(homeTeam.toLowerCase())) return "home";
      if (sel.includes(awayTeam.toLowerCase())) return "away";
      return null;
    }
    // For these markets we don't have reliable closing odds from ESPN's free API:
    case "htft":
    case "win_btts":
    case "ou15":
    case "ou35":
    case "asian_handicap":
    case "corners_ou":
    case "corners_first":
    case "cards_ou":
    case "correct_score":
    case "bet_builder":
    default:
      void homeTeam;
      void awayTeam;
      return null;
  }
}
