/**
 * Shared types used across scrapers, prediction engine, and API.
 */

export interface NormalizedMatch {
  externalId: string; // "2026-07-17:home:away"
  matchDate: string; // Brussels date "YYYY-MM-DD"
  kickoffUtc: Date;
  kickoffBrussels: string; // "HH:MM"
  leagueName: string;
  country: string;
  homeTeam: string;
  awayTeam: string;
}

export interface RawSourcePrediction {
  // Per-market raw picks from a source — best-effort parse
  "1x2"?: "1" | "X" | "2";
  htft?: string; // "1/1", "X/1", etc.
  btts?: "yes" | "no";
  ou25?: "over" | "under";
  ou15?: "over" | "under";
  ou35?: "over" | "under";
  correctScore?: string; // "2-1"
  asianHandicap?: string; // "home -1.5"
  cornersOu?: string; // "over 9.5"
  cardsOu?: string; // "over 4.5"
  // Implied probabilities (source-stated, when available)
  probabilities?: {
    home?: number;
    draw?: number;
    away?: number;
  };
  // Bookmaker odds if the source exposes them
  odds?: {
    home?: number;
    draw?: number;
    away?: number;
    over25?: number;
    under25?: number;
  };
  // Free-form payload for audit
  raw: Record<string, unknown>;
}

export interface ScrapedMatchData {
  match: NormalizedMatch;
  prediction: RawSourcePrediction;
}

export interface ScrapeResult {
  source: string;
  matches: ScrapedMatchData[];
  startedAt: Date;
  finishedAt: Date;
  error?: string;
}

// Final prediction record the engine outputs
export interface EnginePrediction {
  market: string;
  selection: string;
  confidence: number; // 0-100
  probability: number; // 0-1
  fairOdds: number;
  bookOdds?: number;
  edge?: number;
  isTopPick: boolean;
  isValueBet: boolean;
  /**
   * Safer-pick flag — set on the selection within each market that has the
   * highest probability (i.e. the lowest-risk side of that market). For
   * binary markets (BTTS, O/U, corners O/U, cards O/U) this is whichever
   * side has probability >= 0.55; for 1X2 it's the highest-probability
   * outcome (probability >= 0.50). Filled in by the post-process pass in
   * buildPredictionsForMatch; individual gen* functions may omit it.
   */
  isSafePick?: boolean;
  /**
   * Consensus strength — number of distinct sources that agree on this pick.
   * 0 when only the engine inferred the pick (no source coverage). Filled in
   * by the post-process pass; individual gen* functions may omit it.
   */
  consensusSources?: number;
  sources: { source: string; pick: string; weight: number }[];
}

export interface EngineMatchPrediction {
  matchId: string;
  predictions: EnginePrediction[];
}

// Market type strings used throughout
export const MARKETS = [
  "1x2",
  "htft",
  "btts",
  "win_btts",
  "ou15",
  "ou25",
  "ou35",
  "asian_handicap",
  "corners_ou",
  "corners_first",
  "cards_ou",
  "correct_score",
  "bet_builder",
] as const;

export type Market = (typeof MARKETS)[number];
