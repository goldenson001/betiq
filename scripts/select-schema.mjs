// scripts/select-schema.mjs
// Picks the right Prisma schema based on DATABASE_URL scheme:
//   - file:./foo.db  → schema.sqlite.prisma
//   - postgresql://  → schema.postgres.prisma
// Copies the chosen file to schema.prisma (which Prisma reads).
// Idempotent — safe to run multiple times.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const prismaDir = join(root, "prisma");

const dbUrl = process.env.DATABASE_URL || "";
const sqliteSchema = join(prismaDir, "schema.sqlite.prisma");
const postgresSchema = join(prismaDir, "schema.postgres.prisma");
const activeSchema = join(prismaDir, "schema.prisma");

let target;
let provider;
if (!dbUrl) {
  console.warn("[select-schema] DATABASE_URL not set — defaulting to PostgreSQL schema.");
  target = postgresSchema;
  provider = "postgresql";
} else if (dbUrl.startsWith("file:")) {
  target = sqliteSchema;
  provider = "sqlite";
} else if (dbUrl.startsWith("postgres")) {
  target = postgresSchema;
  provider = "postgresql";
} else {
  console.warn(`[select-schema] Unrecognized DATABASE_URL scheme — defaulting to PostgreSQL.`);
  target = postgresSchema;
  provider = "postgresql";
}

if (!existsSync(target)) {
  console.error(`[select-schema] Source schema not found: ${target}`);
  process.exit(1);
}

// Check if active schema already matches (skip write to avoid needless churn)
const targetContent = readFileSync(target, "utf8");
const activeContent = existsSync(activeSchema) ? readFileSync(activeSchema, "utf8") : "";
if (targetContent === activeContent) {
  console.log(`[select-schema] Active schema already set to ${provider}.`);
  process.exit(0);
}

copyFileSync(target, activeSchema);
console.log(`[select-schema] Active schema set to ${provider} (${dbUrl.slice(0, 25)}...).`);
