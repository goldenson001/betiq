import { db } from "@/lib/db";

async function main() {
  const sources = await db.source.findMany({ orderBy: { name: "asc" } });
  console.log("=== Sources registered ===");
  for (const s of sources) {
    console.log(`  ${s.name.padEnd(20)} weight=${s.weight} lastScraped=${s.lastScrapedAt?.toISOString() ?? "never"}`);
  }

  console.log("\n=== Recent scrape logs (last 24h) ===");
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const logs = await db.scrapeLog.findMany({
    where: { startedAt: { gte: since } },
    orderBy: { startedAt: "desc" },
    take: 30,
  });
  for (const l of logs) {
    console.log(`  ${l.source.padEnd(20)} ${l.status.padEnd(8)} matches=${l.matchesFound} ${l.error ? `err="${l.error.slice(0, 80)}"` : ""}`);
  }

  console.log("\n=== Raw predictions per source (today) ===");
  const today = new Date().toISOString().slice(0, 10);
  const rawCounts = await db.rawPrediction.groupBy({
    by: ["sourceId"],
    _count: { _all: true },
  });
  for (const rc of rawCounts) {
    const src = await db.source.findUnique({ where: { id: rc.sourceId } });
    console.log(`  ${src?.name?.padEnd(20) ?? "unknown"} ${rc._count._all} raw predictions`);
  }

  console.log("\n=== Total matches with predictions today ===");
  const matchCount = await db.match.count({ where: { matchDate: today } });
  console.log(`  ${matchCount} matches for ${today}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
