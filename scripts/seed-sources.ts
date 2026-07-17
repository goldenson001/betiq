/**
 * scripts/seed-sources.ts
 * Ensures the 4 source rows (ESPN, PredictZ, WinDrawWin, StatArea) exist
 * in the database. Idempotent — safe to run multiple times.
 *
 * Usage: npx tsx scripts/seed-sources.ts
 */
import { ensureSources } from "@/lib/scrapers/orchestrator";
import { db } from "@/lib/db";

async function main() {
  console.log("Ensuring 4 sources exist...");
  await ensureSources();
  const sources = await db.source.findMany({ select: { name: true, displayName: true, weight: true } });
  console.log("Current sources:");
  for (const s of sources) {
    console.log(`  ${s.displayName.padEnd(15)} weight=${s.weight}`);
  }
  console.log(`\n✅ ${sources.length} sources in DB.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
