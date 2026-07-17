#!/usr/bin/env bash
# scripts/vercel-setup.sh
# One-shot helper to:
#   1. Apply the Prisma schema to your PostgreSQL database
#   2. Seed it with the 4 sources (ESPN, PredictZ, WinDrawWin, StatArea)
#   3. Print the URL to hit /api/trigger?phase=all on Vercel
#
# Usage:
#   DATABASE_URL='postgresql://...' bash scripts/vercel-setup.sh
#
# Run this locally AFTER you've added DATABASE_URL to Vercel env vars
# and AFTER the first Vercel deploy has finished (so the Prisma client
# build matches the schema).

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "Usage: DATABASE_URL='postgresql://...' bash scripts/vercel-setup.sh"
  exit 1
fi

echo "[1/3] Selecting PostgreSQL schema..."
node scripts/select-schema.mjs

echo
echo "[2/3] Pushing schema to database..."
npx prisma db push --skip-generate

echo
echo "[3/3] Seeding sources..."
npx tsx scripts/seed-sources.ts

echo
echo "✅ Database ready."
echo
echo "Next steps:"
echo "  1. Make sure your Vercel deployment finished (with DATABASE_URL set)."
echo "  2. Visit https://YOUR-APP.vercel.app/api/trigger?phase=all to backfill today's matches."
echo "  3. Visit https://YOUR-APP.vercel.app/api/diagnose to verify."
echo "  4. Open https://YOUR-APP.vercel.app/ for the dashboard."
