/**
 * Cleanup Polluted Scheduled Match Scores
 * ───────────────────────────────────────────
 * One-time repair script for the legacy bug where /api/scores/live wrote
 * homeScore=0 / awayScore=0 to MATCH rows whose status was "scheduled".
 * The bug caused the dashboard to render "0-0" fulltime-style boxes on
 * matches that hadn't kicked off yet.
 *
 * This script:
 *   1. Finds all matches with status="scheduled" AND non-null scores
 *      (i.e. the polluted rows).
 *   2. Resets their homeScore / awayScore / htHomeScore / htAwayScore to NULL.
 *   3. Audits the predictions table for any prediction that was incorrectly
 *      marked `evaluated=true` against a match that's NOT finished — those
 *      get reset to `evaluated=false, correct=NULL` so the next feedback
 *      run can evaluate them against the real result.
 *
 * DRY-RUN by default. Pass --apply to actually write changes.
 *
 * USAGE:
 *   npx tsx scripts/cleanup-scheduled-scores.ts            # dry-run
 *   npx tsx scripts/cleanup-scheduled-scores.ts --apply    # apply changes
 */

import { db } from "../src/lib/db";

async function main() {
  const apply = process.argv.includes("--apply");

  console.log("═".repeat(78));
  console.log("  Cleanup Polluted Scheduled-Match Scores");
  console.log(`  Mode: ${apply ? "APPLY (writes to DB)" : "DRY-RUN (no writes)"}`);
  console.log("═".repeat(78));

  // ── Step 1: Find polluted scheduled matches ───────────────────────────────
  // A polluted row = status="scheduled" but homeScore or awayScore is non-null.
  // (ESPN's pre-match payload sends score="0" for both sides; the old code
  // parsed that into numeric 0 instead of null.)
  const polluted = await db.match.findMany({
    where: {
      status: "scheduled",
      OR: [{ homeScore: { not: null } }, { awayScore: { not: null } }],
    },
    select: {
      id: true,
      externalId: true,
      homeTeam: true,
      awayTeam: true,
      matchDate: true,
      status: true,
      homeScore: true,
      awayScore: true,
      htHomeScore: true,
      htAwayScore: true,
    },
  });

  console.log();
  console.log(`  Polluted scheduled matches found: ${polluted.length}`);
  if (polluted.length > 0) {
    console.log("  ────────────────────────────────────────────────────────────────");
    console.log("  Sample (first 10):");
    for (const m of polluted.slice(0, 10)) {
      console.log(
        `    ${m.matchDate}  ${m.homeTeam} v ${m.awayTeam}  ` +
          `[status=${m.status}  FT=${m.homeScore}-${m.awayScore}  HT=${m.htHomeScore}-${m.htAwayScore}]  ` +
          `id=${m.id}`
      );
    }
    if (polluted.length > 10) {
      console.log(`    ... and ${polluted.length - 10} more`);
    }
    console.log("  ────────────────────────────────────────────────────────────────");
  }

  // ── Step 2: Find predictions that were incorrectly evaluated ──────────────
  // A prediction is incorrectly evaluated if it has `evaluated=true` but its
  // match status is NOT "finished" (e.g. it was evaluated against a fake 0-0
  // when the match was actually scheduled).
  const badEvaluations = await db.prediction.findMany({
    where: { evaluated: true, match: { status: { not: "finished" } } },
    select: {
      id: true,
      market: true,
      selection: true,
      correct: true,
      match: {
        select: { id: true, homeTeam: true, awayTeam: true, matchDate: true, status: true, homeScore: true, awayScore: true },
      },
    },
  });

  console.log();
  console.log(`  Predictions incorrectly evaluated (match not finished): ${badEvaluations.length}`);
  if (badEvaluations.length > 0) {
    console.log("  ────────────────────────────────────────────────────────────────");
    console.log("  Sample (first 10):");
    for (const p of badEvaluations.slice(0, 10)) {
      console.log(
        `    ${p.match.matchDate}  ${p.match.homeTeam} v ${p.match.awayTeam}  ` +
          `market=${p.market}  selection=${p.selection}  ` +
          `[matchStatus=${p.match.status}  matchFT=${p.match.homeScore}-${p.match.awayScore}]  ` +
          `wasCorrect=${p.correct}`
      );
    }
    if (badEvaluations.length > 10) {
      console.log(`    ... and ${badEvaluations.length - 10} more`);
    }
    console.log("  ────────────────────────────────────────────────────────────────");
  }

  // ── Step 3: Also find matches marked resultProcessed=true but not finished ──
  // If a scheduled match was marked resultProcessed=true, the feedback loop
  // would skip it forever — but the predictions inside were never correctly
  // evaluated. Reset resultProcessed=false so the feedback loop can reprocess.
  const prematureProcessed = await db.match.findMany({
    where: { resultProcessed: true, status: { not: "finished" } },
    select: { id: true, homeTeam: true, awayTeam: true, matchDate: true, status: true },
  });

  console.log();
  console.log(`  Matches marked resultProcessed=true but NOT finished: ${prematureProcessed.length}`);
  if (prematureProcessed.length > 0) {
    console.log("  ────────────────────────────────────────────────────────────────");
    for (const m of prematureProcessed.slice(0, 10)) {
      console.log(`    ${m.matchDate}  ${m.homeTeam} v ${m.awayTeam}  [status=${m.status}]  id=${m.id}`);
    }
    if (prematureProcessed.length > 10) {
      console.log(`    ... and ${prematureProcessed.length - 10} more`);
    }
    console.log("  ────────────────────────────────────────────────────────────────");
  }

  if (!apply) {
    console.log();
    console.log("  ────────────────────────────────────────────────────────────────");
    console.log("  DRY-RUN: no changes made. Re-run with --apply to write fixes:");
    console.log("    npx tsx scripts/cleanup-scheduled-scores.ts --apply");
    console.log("  ────────────────────────────────────────────────────────────────");
    await db.$disconnect();
    return;
  }

  // ── APPLY: Reset polluted scheduled-match scores to NULL ──────────────────
  console.log();
  console.log("  Applying fixes...");

  if (polluted.length > 0) {
    const res = await db.match.updateMany({
      where: {
        status: "scheduled",
        OR: [{ homeScore: { not: null } }, { awayScore: { not: null } }],
      },
      data: { homeScore: null, awayScore: null, htHomeScore: null, htAwayScore: null },
    });
    console.log(`  ✓ Reset scores on ${res.count} scheduled matches → NULL`);
  }

  if (badEvaluations.length > 0) {
    const res = await db.prediction.updateMany({
      where: { evaluated: true, match: { status: { not: "finished" } } },
      data: { evaluated: false, correct: null },
    });
    console.log(`  ✓ Reset ${res.count} incorrectly-evaluated predictions → evaluated=false, correct=NULL`);
  }

  if (prematureProcessed.length > 0) {
    const res = await db.match.updateMany({
      where: { resultProcessed: true, status: { not: "finished" } },
      data: { resultProcessed: false },
    });
    console.log(`  ✓ Reset resultProcessed=false on ${res.count} non-finished matches`);
  }

  console.log();
  console.log("  ✓ Done. The dashboard will no longer show fake 0-0 scores on");
  console.log("    scheduled matches, and the feedback loop will re-evaluate");
  console.log("    any reset predictions once their matches actually finish.");

  await db.$disconnect();
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
