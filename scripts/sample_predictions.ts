import { db } from "@/lib/db";

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const matches = await db.match.findMany({
    where: { matchDate: today },
    include: {
      league: true,
      rawPredictions: { include: { source: true } },
      predictions: true,
    },
    take: 3,
  });

  for (const m of matches) {
    console.log(`\n=== ${m.homeTeam} vs ${m.awayTeam} (${m.league.name}) ===`);
    console.log(`  kickoff: ${m.kickoffBrussels} Brussels`);
    if (m.oddsJson) console.log(`  match.oddsJson: ${m.oddsJson}`);
    if (m.h2hJson) console.log(`  match.h2hJson: ${(m.h2hJson as string).slice(0, 150)}...`);
    if (m.homeForm) console.log(`  homeForm: ${m.homeForm}`);
    if (m.awayForm) console.log(`  awayForm: ${m.awayForm}`);

    for (const rp of m.rawPredictions) {
      const payload = JSON.parse(rp.payloadJson);
      console.log(`  [${rp.source.name}] pick=${rp.predicted1X2 ?? "?"} odds=${JSON.stringify(payload.odds ?? {})} probs=${JSON.stringify(payload.probabilities ?? {})}`);
    }

    // Show top compound prediction
    const top = m.predictions.find((p) => p.isTopPick);
    if (top) {
      console.log(`  >> TOP PICK: ${top.market} / ${top.selection} @ conf=${top.confidence.toFixed(2)} prob=${top.probability.toFixed(2)} bookOdds=${top.bookOdds} edge=${(top.edge * 100).toFixed(1)}% sources=${top.consensusSources}`);
    }
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
