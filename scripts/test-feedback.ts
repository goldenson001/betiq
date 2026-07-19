import { db } from "../src/lib/db";
import { updateParlayTierStats, loadAllParlayTierStats } from "../src/lib/learning/parlay-ml";

async function main() {
  console.log("=== Testing feedback loop: updateParlayTierStats ===\n");

  // Simulate 5 settled safest-tier parlays: 4 won, 1 lost
  console.log("Simulating 5 settled 'safest' parlays (4 won, 1 lost)...");
  for (let i = 0; i < 4; i++) {
    await updateParlayTierStats("safest", true, 3, 3, 0.51, "2026-07-1" + i);
  }
  await updateParlayTierStats("safest", false, 3, 2, 0.51, "2026-07-15");
  console.log("✓ Done\n");

  // Simulate 3 settled medium_risk parlays: 1 won, 2 lost
  console.log("Simulating 3 settled 'medium_risk' parlays (1 won, 2 lost)...");
  await updateParlayTierStats("medium_risk", true, 4, 4, 0.37, "2026-07-10");
  await updateParlayTierStats("medium_risk", false, 4, 3, 0.37, "2026-07-12");
  await updateParlayTierStats("medium_risk", false, 4, 2, 0.37, "2026-07-15");
  console.log("✓ Done\n");

  // Load and display
  const stats = await loadAllParlayTierStats();
  console.log("Final tier stats:");
  for (const [tier, s] of stats.entries()) {
    console.log(`  ${tier}: ${s.wonParlays}/${s.totalParlays} won (lifetime ${(s.lifetimeWinRate*100).toFixed(1)}%) · rolling ${(s.rollingWinRate*100).toFixed(1)}% · ${s.sampleCount} samples · ${s.totalLegs} legs · ${s.wonLegs} won`);
  }
  console.log("\n=== Test complete ===");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
