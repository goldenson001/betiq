import { db } from "@/lib/db";

async function main() {
  const matchCount = await db.match.count();
  const predCount = await db.prediction.count();
  const parlayCount = await db.parlay.count();
  const sourceCount = await db.source.count();
  console.log(`Matches: ${matchCount}, Predictions: ${predCount}, Parlays: ${parlayCount}, Sources: ${sourceCount}`);

  // Sample varied predictions
  const sample = await db.prediction.findMany({
    where: { match: { matchDate: "2026-07-17" } },
    include: { match: true },
    take: 20,
    orderBy: { confidence: "desc" },
  });
  console.log("\nTop 20 predictions:");
  for (const p of sample) {
    console.log(`  ${p.confidence.toString().padStart(3)}% [${p.market.padEnd(17)}] ${(p.selection || "").padEnd(35)} odds=${(p.bookOdds ?? 0).toFixed(2).padStart(6)} edge=${((p.edge ?? 0) * 100).toFixed(1).padStart(6)}% val=${p.isValueBet} ${p.match.homeTeam} v ${p.match.awayTeam}`);
  }

  // Distribution of confidence
  const allPreds = await db.prediction.findMany({ where: { match: { matchDate: "2026-07-17" } }, select: { confidence: true, market: true, isValueBet: true, isTopPick: true } });
  const buckets = { "0-30": 0, "30-50": 0, "50-70": 0, "70-85": 0, "85-100": 0 };
  for (const p of allPreds) {
    if (p.confidence < 30) buckets["0-30"]++;
    else if (p.confidence < 50) buckets["30-50"]++;
    else if (p.confidence < 70) buckets["50-70"]++;
    else if (p.confidence < 85) buckets["70-85"]++;
    else buckets["85-100"]++;
  }
  console.log("\nConfidence distribution:", buckets);

  // Per-market count
  const byMarket: Record<string, number> = {};
  for (const p of allPreds) byMarket[p.market] = (byMarket[p.market] || 0) + 1;
  console.log("Per market:", byMarket);

  // Value bets count
  const valueBets = allPreds.filter(p => p.isValueBet).length;
  const topPicks = allPreds.filter(p => p.isTopPick).length;
  console.log(`\nValue bets: ${valueBets}, Top picks: ${topPicks}`);

  // Sample parlays
  const parlays = await db.parlay.findMany({ where: { matchDate: "2026-07-17" } });
  console.log("\nParlays:");
  for (const p of parlays) {
    console.log(`  ${p.type.padEnd(12)} legs=${p.legsCount} odds=${p.combinedOdds.toFixed(2)} conf=${p.confidence}% ev=${(p.expectedValue * 100).toFixed(1)}%`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
