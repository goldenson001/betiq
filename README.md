# BetIQ — AI Football Predictions Platform

Self-learning football prediction platform that pulls **real match data** from the ESPN Soccer API (fixtures, team form, head-to-head records, DraftKings odds) and layers consensus predictions from PredictZ, WinDrawWin, and StatArea on top. A weighted confidence engine produces compound predictions for 12+ betting markets per match, builds daily parlays, and runs a self-learning feedback loop that recalibrates source weights from real match results.

---

## Highlights

- **Real data — no synthetic fallbacks.** ESPN is the canonical fixture source (70+ leagues). DraftKings odds are de-vigged to compute true probabilities.
- **12 betting markets per match**: 1X2, Double Chance, Over/Under 1.5/2.5/3.5, Both Teams to Score, Asian Handicap, Correct Score, Half-Time/Full-Time, Corners O/U, Corners First, Bet Builder.
- **Weighted confidence engine** — sources start at weight 0.5 (ESPN at 0.7) and self-adjust daily based on actual hit rate.
- **Parlay builder** — surfaces three daily accumulators: `daily_best` (greedy EV-maximizing), `safe` (legs ≥ 70% probability), `value` (top positive-edge bets).
- **Self-learning feedback loop** — fetches real ESPN final scores each morning, evaluates every past prediction, updates per-source accuracy/ROI/calibration, and writes a `PerformanceSnapshot` for the day.
- **Brussels-timezone scheduler** — runs the full pipeline at 00:00 CET/CEST daily, with on-boot backfill.
- **Mobile-responsive dashboard** — leagues grouped, match detail drawer with all 12 markets, parlay cards, value-bet list, performance charts.
- **API surface** — `/api/matches`, `/api/parlays`, `/api/performance`, `/api/trigger?phase=...`, `/api/health`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Dashboard (Next.js 16 / React / Tailwind / shadcn-ui)      │
│   - Matches tab  - Parlays tab                              │
│   - Value Bets   - Performance tab                          │
└─────────────┬───────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  API routes  /api/matches · /api/parlays · /api/trigger     │
│               /api/performance · /api/health                │
└─────────────┬───────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  Scheduler  (instrumentation.ts → startScheduler)           │
│   - on-boot backfill                                         │
│   - 00:00 Brussels daily run                                 │
└─────────────┬───────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  Pipeline (runDailyPipeline)                                │
│   1. Feedback loop  (process past unprocessed dates)        │
│   2. Scrape          (ESPN + PredictZ + WDW + StatArea)     │
│   3. Predict         (aggregate raw → compound per market)  │
│   4. Parlays         (best / safe / value)                  │
└─────────────┬───────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  SQLite (dev) │ PostgreSQL (prod)  via Prisma ORM           │
│   Match · Prediction · RawPrediction · Source · Parlay      │
│   ScrapeLog · PerformanceSnapshot · ModelState              │
└─────────────────────────────────────────────────────────────┘
```

### Key files

| Path | Purpose |
|------|---------|
| `src/lib/scrapers/espn.ts` | ESPN scoreboard + summary fetcher, odds parser, results fetcher |
| `src/lib/scrapers/orchestrator.ts` | Phase-1 (store ESPN fixtures) + Phase-2 (attach consensus) |
| `src/lib/prediction/engine.ts` | Weighted aggregation → 12 markets × every match |
| `src/lib/confidence/engine.ts` | Parlay builder (best / safe / value) |
| `src/lib/learning/feedback.ts` | ESPN-results-based evaluation + source-weight updates |
| `src/lib/scheduler/scheduler.ts` | On-boot backfill + daily 00:00 Brussels timer |
| `src/lib/scheduler/pipeline.ts` | Orchestrates feedback → scrape → predict → parlays |
| `src/app/page.tsx` | Dashboard (matches / parlays / value / performance tabs) |
| `src/components/dashboard/match-card.tsx` | Per-match card with top pick + 12-market breakdown |
| `prisma/schema.prisma` | Database schema (8 models) |
| `scripts/run_pipeline.ts` | CLI pipeline runner for manual / cron use |

---

## Quick start (local dev)

```bash
# 1. Install deps
bun install            # or: npm install

# 2. Configure env
cp .env.example .env
# Edit .env — DATABASE_URL defaults to ./db/custom.db (SQLite)

# 3. Create DB schema
npx prisma db push

# 4. Run the pipeline once to populate today's matches
npx tsx scripts/run_pipeline.ts

# 5. Start the dev server
npm run dev
# Dashboard: http://localhost:3000
```

The scheduler will also auto-run the pipeline on boot if today's hasn't run yet, then re-run at 00:00 Brussels daily.

---

## API reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/matches?date=YYYY-MM-DD` | GET | All matches for a date, grouped by league, with all 12 predictions per match |
| `/api/parlays?date=YYYY-MM-DD` | GET | Daily best / safe / value parlays with leg breakdown |
| `/api/performance?date=YYYY-MM-DD` | GET | Performance snapshot, per-source accuracy, recent scrape logs |
| `/api/trigger?phase=all\|scrape\|predict\|parlays\|feedback&date=YYYY-MM-DD` | GET | Manually trigger any pipeline phase |
| `/api/health` | GET | Liveness probe (Docker / k8s healthcheck) |

---

## Deployment

### Option A — Docker Compose (recommended)

```bash
cp .env.example .env
# Edit .env: set DATABASE_URL to PostgreSQL
docker compose up -d
```

The stack includes:
- **app** — Next.js standalone server on port 3000
- **db** — PostgreSQL 16 (persistent volume)
- **caddy** — HTTPS reverse proxy (edit `Caddyfile` to set your domain)

The app boots, runs `prisma db push` to apply schema, then starts the Next.js server. The scheduler fires the pipeline immediately if today's data is missing.

### Option B — Vercel / Netlify

```bash
vercel deploy
```

Set `DATABASE_URL` to a hosted PostgreSQL (Neon, Supabase, Railway). Note: the long-running scheduler (`setInterval`) only works on a long-lived server — on Vercel you'll need an external cron (e.g. Vercel Cron, cron-job.org) hitting `/api/trigger?phase=all` daily at 00:00 Brussels.

### Option C — Bare metal / VPS

```bash
git clone <your-repo>
cd betiq
bun install
cp .env.example .env  # edit DATABASE_URL
npx prisma db push
bun run build
NODE_ENV=production bun .next/standalone/server.js
```

Use `pm2` or `systemd` to keep the process alive. Optionally front with Caddy using the included `Caddyfile`.

---

## Self-learning model

Every source (ESPN, PredictZ, WinDrawWin, StatArea) has a row in the `Source` table with:

- `weight` — current trust weight in [0,1], starts at 0.5 (ESPN at 0.7)
- `totalPredictions`, `correctPredictions`, `accuracy`
- `roi` — flat-bet ROI following this source's 1X2 picks
- `calibration` — how well its probability estimates match reality

Each morning, `runFeedbackLoopForUnprocessedDates()`:

1. Fetches real ESPN final scores for every unprocessed past date.
2. Evaluates each prediction (1X2, O/U, BTTS, AH, CS, HT/FT, corners).
3. Updates `Prediction.evaluated` / `Prediction.correct`.
4. Recomputes per-source `accuracy`, `roi`, `calibration`.
5. Updates `Source.weight` using exponential moving average of recent accuracy.
6. Writes a `PerformanceSnapshot` row with daily aggregates.

The next pipeline run uses the updated weights, so the model continuously improves.

---

## Tech stack

- **Framework**: Next.js 16 (App Router, standalone output)
- **Language**: TypeScript 5
- **UI**: Tailwind CSS, shadcn/ui, Radix UI, Recharts
- **ORM**: Prisma 6 (SQLite dev, PostgreSQL prod)
- **Scraping**: native `fetch` + rotating UA + retry/throttle
- **Math**: Poisson PMF for correct-score, de-vigged 3-way moneyline, weighted mode aggregation
- **Scheduler**: native `setInterval` + `setTimeout` (no external cron required)

---

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:/app/db/custom.db` | Prisma datasource URL |
| `TZ` | `Europe/Brussels` | Timezone for date bucketing + scheduler |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `production` | Node env |
| `DISABLE_SCHEDULER` | (unset) | Set to `true` to disable the daily scheduler |
| `ENABLE_ESPN` | `1` | Toggle ESPN scraper |
| `ENABLE_PREDICTZ` | `1` | Toggle PredictZ scraper |
| `ENABLE_WINDRAWWIN` | `1` | Toggle WinDrawWin scraper |
| `ENABLE_STATAREA` | `1` | Toggle StatArea scraper |

---

## License

MIT — see `LICENSE` file for details.
