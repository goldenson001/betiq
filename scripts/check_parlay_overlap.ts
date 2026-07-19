import { db } from "@/lib/db";

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const parlays = await db.parlay.findMany({ where: { matchDate: today } });

  if (parlays.length === 0) {
    console.log("No parlays for today.");
    process.exit(0);
  }

  console.log(`=== Parlays for ${today} ===`);
  const matchToTiers = new Map<string, string[]>();
  for (const p of parlays) {
    const legs = JSON.parse(p.legsJson) as Array<{ matchId: string; matchLabel: string; market: string; selection: string; odds: number; probability: number }>;
    console.log(`\n[${p.type}] ${legs.length} legs, combinedOdds=${p.combinedOdds.toFixed(2)}, combinedProb=${(p.combinedProbability * 100).toFixed(1)}%`);
    for (const leg of legs) {
      console.log(`  - ${leg.matchLabel} | ${leg.market} → ${leg.selection} @ ${leg.odds.toFixed(2)} (p=${(leg.probability * 100).toFixed(0)}%)`);
      const existing = matchToTiers.get(leg.matchId) ?? [];
      existing.push(p.type);
      matchToTiers.set(leg.matchId, existing);
    }
  }

  console.log("\n=== Overlap check ===");
  let overlapCount = 0;
  for (const [matchId, tiers] of matchToTiers) {
    if (tiers.length > 1) {
      overlapCount++;
      console.log(`  OVERLAP: match ${matchId} appears in: ${tiers.join(", ")}`);
    }
  }
  if (overlapCount === 0) {
    console.log(`  ✓ No overlap — all ${matchToTiers.size} distinct matches appear in exactly one parlay.`);
  } else {
    console.log(`  ✗ Found ${overlapCount} overlapping matches!`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
