/**
 * Cleanup Synthetic History
 * ──────────────────────────
 * Removes all synthetic matches (externalId starts with "synthetic-")
 * and their cascade predictions. Use after running the backtester to
 * restore the DB to its real state.
 *
 * USAGE:
 *   npx tsx scripts/cleanup-synthetic-history.ts
 */

import { db } from "../src/lib/db";

async function main() {
  console.log("═".repeat(78));
  console.log("  Cleanup Synthetic History");
  console.log("═".repeat(78));

  const before = await db.match.count({ where: { externalId: { startsWith: "synthetic-" } } });
  console.log(`  Synthetic matches to delete: ${before}`);

  if (before === 0) {
    console.log("  Nothing to clean. ✓");
    process.exit(0);
  }

  // Cascade delete predictions
  const result = await db.match.deleteMany({ where: { externalId: { startsWith: "synthetic-" } } });
  console.log(`  Deleted ${result.count} matches (predictions cascade-deleted).`);
  console.log();
  console.log("  ✓ Done. DB is back to real-data-only state.");

  await db.$disconnect();
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
