"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Shield, Flame, Trophy, Sparkles, Target, Check, X, Clock, Brain } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatKelly } from "@/lib/dashboard/format";

export interface ParlayLeg {
  predictionId: string;
  matchId: string;
  matchLabel: string;
  market: string;
  selection: string;
  odds: number;
  probability: number;
  confidence: number;
}

/** Optional live-status payload for each leg — supplied by /api/scores/live. */
export interface ParlayLegLive {
  decided: boolean;
  won: boolean;
  pending: boolean;
  matchStatus: string;
  homeScore: number | null;
  awayScore: number | null;
}

export interface ParlayLiveSummary {
  legsWon: number;
  legsLost: number;
  legsPending: number;
  busted: boolean;
  won: boolean;
  hasLiveLeg: boolean;
  legs: Record<string, ParlayLegLive>; // keyed by predictionId
}

export interface ParlayView {
  id: string;
  matchDate: string;
  /** One of: safest | medium_risk | high_risk | mega_odds | odds_3_a | odds_3_b | odds_5_a | odds_5_b (legacy: daily_best | safe | value) */
  type: string;
  legs: ParlayLeg[];
  legsCount: number;
  combinedProbability: number;
  combinedOdds: number;
  confidence: number;
  expectedValue: number;
  evaluated: boolean;
  won: boolean | null;
  /** Kelly criterion recommended stake (fraction of bankroll, 0-0.02). */
  recommendedStake?: number | null;
  /** Full Kelly fraction (before fractional adjustment). */
  kellyFraction?: number | null;
  /** Optional live in-play status for each leg — injected by the dashboard. */
  live?: ParlayLiveSummary;
  /** ── ML signals (from /api/parlays) ─────────────────────────────────── */
  /** Parlay-level ML reliability score (avg of leg reliabilities), 0-1. */
  mlScore?: number | null;
  /** JSON string with per-leg ML breakdown — see parlay-ml.ts for shape. */
  mlComponentsJson?: string | null;
  /** Bayesian-adjusted combined probability (prior + observed tier win rate). */
  mlAdjustedProbability?: number | null;
  /** Number of historical settled parlays of this tier backing the Bayesian. */
  mlSampleCount?: number | null;
}

// ── ML helpers (mirror of src/lib/learning/parlay-ml.ts mlScoreToGrade) ──────
function mlScoreToGrade(score: number): { grade: string; color: string; label: string } {
  if (score >= 0.85) return { grade: "A+", color: "emerald", label: "Elite" };
  if (score >= 0.75) return { grade: "A", color: "emerald", label: "Strong" };
  if (score >= 0.60) return { grade: "B", color: "lime", label: "Good" };
  if (score >= 0.45) return { grade: "C", color: "amber", label: "Speculative" };
  return { grade: "D", color: "rose", label: "Weak" };
}

const GRADE_COLOR_CLASS: Record<string, string> = {
  emerald: "border-emerald-400 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10",
  lime: "border-lime-400 text-lime-700 dark:text-lime-300 bg-lime-500/10",
  amber: "border-amber-400 text-amber-700 dark:text-amber-300 bg-amber-500/10",
  rose: "border-rose-400 text-rose-700 dark:text-rose-300 bg-rose-500/10",
};

/** Parse mlComponentsJson safely. Returns null on parse failure. */
function parseMLComponents(json: string | null | undefined): {
  parlayMLScore: number | null;
  bayesianAdjustedProb: number;
  sampleCount: number;
  legs: Array<{
    predictionId: string;
    matchLabel: string;
    market: string;
    selection: string;
    reliability: number | null;
    calibratedProb: number | null;
    adjustedProb: number | null;
    components: Record<string, number> | null;
  }>;
} | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const TYPE_META: Record<
  string,
  { label: string; icon: typeof Trophy; color: string; border: string; blurb: string }
> = {
  safest: {
    label: "Safest Bet",
    icon: Shield,
    color: "text-emerald-500",
    border: "border-l-emerald-500",
    blurb: "2–3 legs · each leg ≥ 75% prob · low-variance high-win-rate",
  },
  medium_risk: {
    label: "Medium Risk",
    icon: TrendingUp,
    color: "text-blue-500",
    border: "border-l-blue-500",
    blurb: "3–4 legs · each leg ≥ 55% prob · balanced growth",
  },
  high_risk: {
    label: "High Risk",
    icon: Flame,
    color: "text-amber-500",
    border: "border-l-amber-500",
    blurb: "4–5 legs · each leg ≥ 40% prob · higher upside, higher variance",
  },
  mega_odds: {
    label: "Mega Odds",
    icon: Sparkles,
    color: "text-fuchsia-500",
    border: "border-l-fuchsia-500",
    blurb: "3–6 legs · target combined odds ≥ 20/1 · lottery-style payout · longshot-tier legs",
  },
  // ── B6: Target-odds parlays (user-requested) ───────────────────────────────
  // Two parlays targeting ~3/1, two targeting ~5/1. Each leg is a high-prob
  // pick (≥70% for odds_3, ≥60% for odds_5). Leg count is whatever it takes
  // to hit the target combined odds — could be 2 legs, could be 6.
  odds_3_a: {
    label: "Target Odds 3 — Pick A",
    icon: Target,
    color: "text-cyan-500",
    border: "border-l-cyan-500",
    blurb: "Best high-prob picks · combined odds ≈ 3.0 · each leg ≥ 70% win prob",
  },
  odds_3_b: {
    label: "Target Odds 3 — Pick B",
    icon: Target,
    color: "text-teal-500",
    border: "border-l-teal-500",
    blurb: "Alternate combo · different matches from Pick A · combined odds ≈ 3.0",
  },
  odds_5_a: {
    label: "Target Odds 5 — Pick A",
    icon: Target,
    color: "text-indigo-500",
    border: "border-l-indigo-500",
    blurb: "Best high-prob picks · combined odds ≈ 5.0 · each leg ≥ 60% win prob",
  },
  odds_5_b: {
    label: "Target Odds 5 — Pick B",
    icon: Target,
    color: "text-violet-500",
    border: "border-l-violet-500",
    blurb: "Alternate combo · different matches from Pick A · combined odds ≈ 5.0",
  },
  // Legacy types (kept for back-compat with old DB rows)
  daily_best: {
    label: "Daily Best Parlay",
    icon: Trophy,
    color: "text-amber-500",
    border: "border-l-primary",
    blurb: "Top EV-driven parlay",
  },
  safe: {
    label: "Safe Accumulator",
    icon: Shield,
    color: "text-emerald-500",
    border: "border-l-emerald-500",
    blurb: "High-probability legs",
  },
  value: {
    label: "Value Bet Parlay",
    icon: TrendingUp,
    color: "text-blue-500",
    border: "border-l-amber-400",
    blurb: "Positive-edge picks",
  },
};

const TYPE_ORDER = [
  "safest",
  "medium_risk",
  "high_risk",
  "mega_odds",
  "odds_3_a",
  "odds_3_b",
  "odds_5_a",
  "odds_5_b",
  "daily_best",
  "safe",
  "value",
];

export function parlayTypeOrder(type: string): number {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? 99 : i;
}

export function ParlayCard({ parlay }: { parlay: ParlayView }) {
  const meta = TYPE_META[parlay.type] ?? TYPE_META.daily_best;
  const Icon = meta.icon;
  const ev = parlay.expectedValue;
  const hasKelly = parlay.recommendedStake !== null && parlay.recommendedStake !== undefined && parlay.recommendedStake > 0;

  // ── ML signals ──────────────────────────────────────────────────────────
  const mlScore = parlay.mlScore ?? null;
  const mlGrade = mlScore !== null ? mlScoreToGrade(mlScore) : null;
  const mlComponents = parseMLComponents(parlay.mlComponentsJson);
  const mlSampleCount = parlay.mlSampleCount ?? 0;
  const mlAdjustedProb = parlay.mlAdjustedProbability ?? null;
  // ML badge shows when we have either a score or learning samples
  const showMLBadge = mlGrade !== null || mlSampleCount > 0;

  // ── Live parlay status (from /api/scores/live) ─────────────────────────
  // Falls back to the persisted `evaluated`/`won` flags when live data isn't
  // available (e.g. before any refresh has happened, or for past dates).
  const live = parlay.live;
  const liveBusted = live?.busted ?? false;
  const liveWon = live?.won ?? false;
  const hasLiveLeg = live?.hasLiveLeg ?? false;
  const showLiveStatus = !!live && (hasLiveLeg || live.legsWon > 0 || live.legsLost > 0 || liveWon);
  const statusBadge = parlay.evaluated
    ? parlay.won
      ? { label: "WON", variant: "default" as const }
      : { label: "LOST", variant: "destructive" as const }
    : showLiveStatus
      ? liveBusted
        ? { label: "BUSTED", variant: "destructive" as const }
        : liveWon
          ? { label: "WON", variant: "default" as const }
          : hasLiveLeg
            ? { label: "LIVE", variant: "outline" as const }
            : { label: "PENDING", variant: "secondary" as const }
      : null;

  return (
    <Card className={cn("overflow-hidden border-l-4", meta.border, liveBusted && !parlay.evaluated && "opacity-70")}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className={cn("h-5 w-5", meta.color)} />
            <div>
              <CardTitle className="text-base">{meta.label}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {parlay.legsCount} {parlay.legsCount === 1 ? "leg" : "legs"} ·{" "}
                <span className="font-mono">Combined odds: {parlay.combinedOdds.toFixed(2)}</span>
              </p>
              <p className="text-[10px] text-muted-foreground italic mt-0.5">{meta.blurb}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {/* ML safety grade — shown when ML signals are present */}
            {showMLBadge && mlGrade && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] gap-1 font-bold uppercase tracking-wider",
                  GRADE_COLOR_CLASS[mlGrade.color] ?? "border-muted text-muted-foreground"
                )}
                title={
                  mlScore !== null
                    ? `ML reliability: ${(mlScore * 100).toFixed(1)}% (${mlGrade.label})\n` +
                      `Bayesian-adjusted prob: ${mlAdjustedProb !== null ? (mlAdjustedProb * 100).toFixed(1) + "%" : "—"}\n` +
                      `Learning samples: ${mlSampleCount} settled ${mlSampleCount === 1 ? "parlay" : "parlays"} of this tier\n` +
                      `Components: prob·consensus·disagreement·market-CLV·source-Brier·source-CLV·tier-history`
                    : `Learning samples: ${mlSampleCount}`
                }
              >
                <Brain className="h-3 w-3" />
                ML {mlGrade.grade}
              </Badge>
            )}
            {showMLBadge && mlSampleCount > 0 && (
              <Badge variant="outline" className="text-[9px] gap-0.5 font-mono">
                {mlSampleCount} samp
              </Badge>
            )}
            {statusBadge && (
              <Badge
                variant={statusBadge.variant}
                className={cn(
                  "text-xs gap-1",
                  statusBadge.label === "LIVE" && "border-rose-400 text-rose-600 dark:text-rose-300"
                )}
              >
                {statusBadge.label === "LIVE" && (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-rose-500"></span>
                  </span>
                )}
                {statusBadge.label}
              </Badge>
            )}
            {showLiveStatus && !liveWon && !liveBusted && (
              <Badge variant="outline" className="text-[10px] gap-1 font-mono">
                {live!.legsWon}W · {live!.legsLost}L · {live!.legsPending}P
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {parlay.legs.slice(0, 6).map((leg, i) => {
          const legLive = live?.legs?.[leg.predictionId];
          // Per-leg visual state
          const legWon = legLive?.decided && legLive?.won;
          const legLost = legLive?.decided && !legLive?.won;
          const legPending = !legLive || !legLive.decided;
          const legIsLive = legLive?.matchStatus === "live";
          const hasScore = legLive?.homeScore !== null && legLive?.homeScore !== undefined && legLive?.awayScore !== null && legLive?.awayScore !== undefined;

          // Per-leg ML reliability (from mlComponentsJson)
          const legML = mlComponents?.legs?.find((l) => l.predictionId === leg.predictionId);
          const legReliability = legML?.reliability ?? null;
          const legGrade = legReliability !== null ? mlScoreToGrade(legReliability) : null;

          return (
            <div
              key={leg.predictionId}
              className={cn(
                "flex items-center gap-3 py-2 px-3 rounded-md text-sm border",
                legWon
                  ? "bg-emerald-500/10 border-emerald-500/40"
                  : legLost
                    ? "bg-rose-500/10 border-rose-500/40 line-through opacity-70"
                    : legIsLive
                      ? "bg-rose-500/5 border-rose-500/30"
                      : "bg-muted/40 border-transparent"
              )}
            >
              <div className="w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center shrink-0">
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{leg.matchLabel}</div>
                <div className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
                  <span className="uppercase tracking-wide">{leg.market.replace(/_/g, " ")}:</span>
                  <span className="font-medium">{leg.selection}</span>
                  {/* Per-leg ML reliability grade */}
                  {legGrade && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[8px] h-3.5 px-1 font-bold gap-0.5",
                        GRADE_COLOR_CLASS[legGrade.color] ?? "border-muted text-muted-foreground"
                      )}
                      title={
                        legReliability !== null
                          ? `ML reliability: ${(legReliability * 100).toFixed(1)}%\n` +
                            `Calibrated prob: ${legML?.calibratedProb !== null && legML?.calibratedProb !== undefined ? (legML.calibratedProb * 100).toFixed(1) + "%" : "—"}\n` +
                            `Adjusted prob: ${legML?.adjustedProb !== null && legML?.adjustedProb !== undefined ? (legML.adjustedProb * 100).toFixed(1) + "%" : "—"}\n` +
                            (legML?.components
                              ? `Components (v2 de-correlated):\n` +
                                `  prob:            ${(legML.components.prob * 100).toFixed(0)}%\n` +
                                `  sourceCohesion:  ${(legML.components.sourceCohesion * 100).toFixed(0)}%  (consensus × lowDisagreement)\n` +
                                `    ├ consensus:   ${(legML.components.consensus * 100).toFixed(0)}%\n` +
                                `    └ lowDisagree: ${(legML.components.lowDisagreement * 100).toFixed(0)}%\n` +
                                `  marketClv:       ${(legML.components.marketClv * 100).toFixed(0)}%\n` +
                                `  sourceQuality:   ${(legML.components.sourceQuality * 100).toFixed(0)}%  (brier × clv)\n` +
                                `    ├ sourceBrier: ${(legML.components.sourceBrier * 100).toFixed(0)}%\n` +
                                `    └ sourceClv:   ${(legML.components.sourceClv * 100).toFixed(0)}%\n` +
                                `  tierHistory:     ${(legML.components.tierHistory * 100).toFixed(0)}%\n` +
                                `  h2h:             ${(legML.components.h2h * 100).toFixed(0)}%  (DOMINANT)`
                              : "")
                          : undefined
                      }
                    >
                      <Brain className="h-2.5 w-2.5" />
                      {legGrade.grade}
                    </Badge>
                  )}
                  {hasScore && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[9px] h-4 px-1 font-mono font-semibold ml-auto",
                        legIsLive
                          ? "border-rose-400 text-rose-600 dark:text-rose-300"
                          : "text-muted-foreground"
                      )}
                    >
                      {legIsLive && (
                        <span className="relative flex h-1 w-1 mr-0.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-1 w-1 bg-rose-500"></span>
                        </span>
                      )}
                      {legLive!.homeScore}-{legLive!.awayScore}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0 flex items-center gap-2">
                {/* Per-leg status icon */}
                {legWon && <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
                {legLost && <X className="h-4 w-4 text-rose-600 dark:text-rose-400" />}
                {legPending && legIsLive && <Clock className="h-3.5 w-3.5 text-rose-500 animate-pulse" />}
                {legPending && !legIsLive && <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
                <div>
                  <div className="font-mono text-sm font-semibold">{leg.odds.toFixed(2)}</div>
                  <div className="text-[10px] text-muted-foreground">{(leg.probability * 100).toFixed(0)}%</div>
                </div>
              </div>
            </div>
          );
        })}
        {parlay.legs.length > 6 && (
          <div className="text-xs text-center text-muted-foreground py-1">
            +{parlay.legs.length - 6} more legs
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 pt-3 mt-2 border-t">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Confidence</div>
            <div className="text-base font-bold text-primary">{parlay.confidence}%</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Win Prob.{mlAdjustedProb !== null && mlSampleCount > 0 ? " (ML adj.)" : ""}
            </div>
            <div className="text-base font-bold flex items-center gap-1">
              {(parlay.combinedProbability * 100).toFixed(1)}%
              {mlAdjustedProb !== null && mlSampleCount > 0 && (
                <span
                  className={cn(
                    "text-[10px] font-mono",
                    mlAdjustedProb > parlay.combinedProbability
                      ? "text-emerald-600 dark:text-emerald-400"
                      : mlAdjustedProb < parlay.combinedProbability
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-muted-foreground"
                  )}
                  title={`Bayesian-adjusted using ${mlSampleCount} settled ${mlSampleCount === 1 ? "parlay" : "parlays"} of this tier.\nPrior (math): ${(parlay.combinedProbability * 100).toFixed(1)}%\nPosterior: ${(mlAdjustedProb * 100).toFixed(1)}%`}
                >
                  → {(mlAdjustedProb * 100).toFixed(1)}%
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Exp. Value</div>
            <div
              className={cn(
                "text-base font-bold flex items-center gap-1",
                ev > 0 ? "text-emerald-500" : "text-rose-500"
              )}
            >
              <TrendingUp className="h-3.5 w-3.5" />
              {ev > 0 ? "+" : ""}
              {(ev * 100).toFixed(1)}%
            </div>
          </div>
        </div>

        {/* ML self-learning footer — shows when Bayesian adjustment is active */}
        {mlSampleCount > 0 && mlAdjustedProb !== null && (
          <div className="flex items-center justify-between gap-2 pt-1 px-3 pb-1 text-[10px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Brain className="h-3 w-3 text-violet-500" />
              <span>
                ML self-learning active · {mlSampleCount} settled {mlSampleCount === 1 ? "parlay" : "parlays"} of this tier
                {mlAdjustedProb < parlay.combinedProbability
                  ? " · stakes reduced (tier underperforming math)"
                  : mlAdjustedProb > parlay.combinedProbability
                    ? " · stakes boosted (tier outperforming math)"
                    : " · stakes match math (tier performing as expected)"}
              </span>
            </div>
          </div>
        )}

        {hasKelly && (
          <div className="flex items-center justify-between gap-2 pt-2 mt-1 border-t border-blue-400/30 bg-blue-400/5 px-3 py-2 rounded-md">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-wider text-blue-950 bg-blue-300 px-1.5 py-0.5 rounded">
                Recommended Stake
              </span>
              <span className="text-[10px] text-muted-foreground">
                Capped at 2% bankroll
              </span>
            </div>
            <div className="text-sm font-mono font-bold text-blue-700 dark:text-blue-300">
              {formatKelly(parlay.recommendedStake)}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
