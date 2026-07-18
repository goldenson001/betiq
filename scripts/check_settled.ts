import { db } from "@/lib/db";

async function main() {
  const total = await db.match.count();
  const finished = await db.match.count({ where: { status: "finished" } });
  const withScores = await db.match.count({
    where: { status: "finished", homeScore: { not: null }, awayScore: { not: null } },
  });
  const evaluated = await db.prediction.count({ where: { evaluated: true, correct: { not: null } } });
  console.log({ total, finished, withScores, evaluated });

  const byDate = await db.match.groupBy({
    by: ["matchDate"],
    where: { status: "finished", homeScore: { not: null } },
    _count: true,
    orderBy: { matchDate: "desc" },
    take: 10,
  });
  console.log("Recent finished match dates:");
  for (const r of byDate) {
    console.log(`  ${r.matchDate}: ${r._count} matches`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
