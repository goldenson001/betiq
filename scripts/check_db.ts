import { db } from "@/lib/db";

async function main() {
  const matches = await db.match.count();
  const predictions = await db.prediction.count();
  const parlays = await db.parlay.count();
  const sources = await db.source.count();
  const scrapes = await db.scrapeLog.count();
  console.log("Counts:", { matches, predictions, parlays, sources, scrapes });
  const logs = await db.scrapeLog.findMany({ take: 5, orderBy: { createdAt: "desc" } });
  console.log("Recent scrape logs:");
  for (const l of logs) {
    console.log(`  ${l.source} ${l.status} matches=${l.matchesFound} err=${l.error ?? "none"}`);
  }
  const sampleMatches = await db.match.findMany({ take: 3, include: { league: true, predictions: true } });
  console.log("Sample matches:");
  for (const m of sampleMatches) {
    console.log(`  ${m.kickoffBrussels} ${m.homeTeam} v ${m.awayTeam} (${m.league?.name}) — ${m.predictions.length} predictions`);
  }
  const sampleParlays = await db.parlay.findMany({ take: 3, orderBy: { createdAt: "desc" } });
  console.log("Sample parlays:");
  for (const p of sampleParlays) {
    console.log(`  ${p.type} legs=${p.legsCount} odds=${p.combinedOdds.toFixed(2)} conf=${p.confidence}% ev=${(p.expectedValue * 100).toFixed(1)}%`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
