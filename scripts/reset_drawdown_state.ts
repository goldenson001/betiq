/**
 * One-shot script: reset the persisted drawdown_state in ModelState back to
 * "normal" so the halt banner clears. The previous 1493.3% drawdown was a
 * calculation bug (now fixed in risk.ts), but the persisted "halted" state
 * keeps stakes zeroed until we reset it.
 *
 * Run once after deploying the drawdown fix.
 */
import { db } from "@/lib/db";

async function main() {
  const existing = await db.modelState.findUnique({ where: { key: "drawdown_state" } });
  console.log(`Current drawdown_state: ${existing?.value ?? "(none)"} (0=normal, 1=degraded, 2=halted)`);

  if (existing) {
    await db.modelState.update({ where: { key: "drawdown_state" }, data: { value: 0 } });
  } else {
    await db.modelState.create({ data: { key: "drawdown_state", value: 0 } });
  }
  console.log("✓ Reset drawdown_state to 0 (normal). Stakes will be restored on next pipeline run.");

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
