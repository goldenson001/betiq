import { db } from "../src/lib/db";
async function main() {
  // Clean up: reset tier stats so production starts fresh
  await db.parlayTierStats.deleteMany({});
  console.log("✓ ParlayTierStats cleared");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
