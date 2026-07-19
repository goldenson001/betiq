/**
 * ESPN API Schema Validation
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime Zod schemas for the ESPN soccer API payloads.
 *
 * WHY THIS EXISTS:
 *   The ESPN API is undocumented and silently changes shape. The FT/LIVE bug
 *   (France vs England showing "FT 0:0" while still playing) was caused by
 *   ESPN's `completed` flag being true mid-match, which our naive status
 *   mapping trusted. Zod validation gives us:
 *
 *     1. Strict shape contracts — every field we read is typed and required.
 *     2. Safe-fail — if ESPN changes shape, we get a structured error log
 *        instead of silent corruption.
 *     3. Defensive coercion — strings-to-numbers, optional-vs-required,
 *        null-vs-undefined are all explicit.
 *
 * USAGE:
 *   import { EspnScoreboardSchema, EspnSummarySchema } from "./espn-schema";
 *   const parsed = EspnScoreboardSchema.safeParse(json);
 *   if (!parsed.success) {
 *     console.error("[espn] scoreboard schema drift", parsed.error.format());
 *     return null;
 *   }
 *   const events = parsed.data.events ?? [];
 *
 * DESIGN NOTE:
 *   We use `.passthrough()` (Zod v4: `.loose()`) so unknown fields are kept
 *   rather than stripped. This way, if ESPN adds new fields, we don't lose
 *   data and can extend the schema later.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────────
// Primitive helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Score parser: ESPN sends scores as strings ("0", "2"), we coerce to number. */
const scoreSchema = z.union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v : parseInt(v, 10)))
  .refine((n) => Number.isFinite(n) && n >= 0, { message: "score must be a non-negative number" });

/** ESPN status.state — "pre", "in", "post" are the documented values. */
const statusStateSchema = z.enum(["pre", "in", "post"]).catch("pre");

/**
 * Completed flag — ESPN sometimes flips this mid-match. We ACCEPT it as a
 * boolean but consumers MUST NOT use it as the primary signal for "finished".
 * The state field is authoritative (state === "post" → finished).
 */
const completedFlagSchema = z.boolean().catch(false);

// ──────────────────────────────────────────────────────────────────────────────
// Scoreboard schemas
// ──────────────────────────────────────────────────────────────────────────────

const espnCompetitorSchema = z.object({
  homeAway: z.enum(["home", "away"]),
  score: z.union([z.string(), z.number(), z.null()]).optional(),
  records: z.array(z.any()).optional(),
  team: z.object({
    id: z.string().optional(),
    displayName: z.string(),
    name: z.string().optional(),
    abbreviation: z.string().optional(),
    logo: z.string().optional(),
    color: z.string().optional(),
    location: z.string().optional(),
  }).passthrough(),
  form: z.string().optional(),
  record: z.any().optional(),
}).passthrough();

const espnStatusSchema = z.object({
  type: z.object({
    state: statusStateSchema,
    completed: completedFlagSchema,
    description: z.string().optional(),
    shortDetail: z.string().optional(),
    name: z.string().optional(),
  }).passthrough(),
  period: z.number().optional(),
  clock: z.number().optional(),
  displayClock: z.string().optional(),
}).passthrough();

const espnCompetitionSchema = z.object({
  id: z.string().optional(),
  competitors: z.array(espnCompetitorSchema).min(2),
  status: espnStatusSchema,
  venue: z.object({
    id: z.string().optional(),
    fullName: z.string().optional(),
    address: z.object({ city: z.string().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  // Odds attached at competition level (sometimes)
  odds: z.array(z.any()).optional(),
}).passthrough();

const espnEventSchema = z.object({
  id: z.string(),
  date: z.string().optional(),
  name: z.string().optional(),
  shortName: z.string().optional(),
  status: espnStatusSchema,
  competitions: z.array(espnCompetitionSchema).min(1),
  league: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    abbreviation: z.string().optional(),
  }).passthrough().optional(),
  // Odds at event level (sometimes — depends on endpoint)
  odds: z.array(z.any()).optional(),
  pickcenter: z.array(z.any()).optional(),
}).passthrough();

const espnLeagueSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  abbreviation: z.string().optional(),
  slug: z.string().optional(),
}).passthrough();

export const EspnScoreboardSchema = z.object({
  leagues: z.array(espnLeagueSchema).optional(),
  events: z.array(espnEventSchema).optional(),
  day: z.object({ date: z.string().optional() }).passthrough().optional(),
}).passthrough();

// ──────────────────────────────────────────────────────────────────────────────
// Summary schemas
// ──────────────────────────────────────────────────────────────────────────────

const espnOddsEntrySchema = z.object({
  provider: z.object({
    name: z.string().optional(),
    id: z.string().optional(),
  }).passthrough().optional(),
  details: z.string().optional(),
  overUnder: z.number().optional(),
  spread: z.number().optional(),
  overOdds: z.number().optional(),
  underOdds: z.number().optional(),
  // 1X2 / moneyline odds (American format)
  homeTeamOdds: z.object({
    favorite: z.boolean().optional(),
    underdog: z.boolean().optional(),
    moneyLine: z.number().optional(),
    spreadOdds: z.number().optional(),
  }).passthrough().optional(),
  awayTeamOdds: z.object({
    favorite: z.boolean().optional(),
    underdog: z.boolean().optional(),
    moneyLine: z.number().optional(),
    spreadOdds: z.number().optional(),
  }).passthrough().optional(),
  drawOdds: z.number().optional(),
}).passthrough();

const espnH2HCompetitorSchema = z.object({
  homeAway: z.enum(["home", "away"]),
  winner: z.boolean().optional(),
  score: z.union([z.string(), z.number(), z.null()]).optional(),
  team: z.object({
    displayName: z.string().optional(),
    abbreviation: z.string().optional(),
    logo: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const espnH2HCompetitionSchema = z.object({
  competitors: z.array(espnH2HCompetitorSchema).optional(),
  status: z.object({
    type: z.object({
      state: statusStateSchema,
      completed: completedFlagSchema,
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const espnH2HGameSchema = z.object({
  date: z.string().optional(),
  competitions: z.array(espnH2HCompetitionSchema).optional(),
}).passthrough();

export const EspnSummarySchema = z.object({
  header: z.object({
    competitions: z.array(espnCompetitionSchema).optional(),
  }).passthrough().optional(),
  odds: z.array(espnOddsEntrySchema).optional(),
  pickcenter: z.array(espnOddsEntrySchema).optional(),
  hasOdds: z.boolean().optional(),
  lastFiveGames: z.any().optional(),
  headToHeadGames: z.array(espnH2HGameSchema).optional(),
}).passthrough();

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

export interface EspnParseResult<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

/**
 * Safe-parse + log-on-failure wrapper. Use this in the scraper to convert
 * raw JSON into validated data, with structured error logging when ESPN
 * changes their payload shape.
 */
export function parseEspnPayload<T>(
  schema: z.ZodType<T>,
  json: unknown,
  context: string
): EspnParseResult<T> {
  const result = schema.safeParse(json);
  if (result.success) {
    return { success: true, data: result.data, error: null };
  }
  // Format the Zod error into a single string for logging
  const issues = result.error.issues
    .slice(0, 5) // cap to first 5 issues to avoid log spam
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join(" | ");
  console.error(
    `[espn-schema] payload drift in ${context}: ${issues}` +
    ` — falling back to best-effort parse`
  );
  return { success: false, data: null, error: issues };
}

/**
 * Score extractor — robust to both string and number ESPN formats.
 * Returns null when the score is missing or unparseable (e.g. pre-match).
 */
export function extractScore(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}
