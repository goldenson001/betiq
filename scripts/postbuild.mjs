// scripts/postbuild.mjs
// Copies static assets into the standalone output directory (for Docker / bare-metal).
// Skips silently when .next/standalone doesn't exist (e.g. on Vercel, which
// ignores `output: "standalone"` and uses its own deployment pipeline).

import { existsSync, mkdirSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const standaloneDir = join(root, ".next", "standalone");
if (!existsSync(standaloneDir)) {
  // Vercel / non-standalone environments — nothing to do.
  process.exit(0);
}

// Mirror .next/static into standalone/.next/static
const staticSrc = join(root, ".next", "static");
const staticDst = join(standaloneDir, ".next", "static");
if (existsSync(staticSrc)) {
  mkdirSync(dirname(staticDst), { recursive: true });
  cpSync(staticSrc, staticDst, { recursive: true });
}

// Mirror public/ into standalone/public
const publicSrc = join(root, "public");
const publicDst = join(standaloneDir, "public");
if (existsSync(publicSrc)) {
  cpSync(publicSrc, publicDst, { recursive: true });
}

console.log("[postbuild] Standalone assets copied.");
