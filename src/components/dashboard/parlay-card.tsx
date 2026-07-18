"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Shield, Flame, Trophy, Sparkles, Target, Check, X, Clock } from "lucide-react";
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
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Win Prob.</div>
            <div className="text-base font-bold">{(parlay.combinedProbability * 100).toFixed(1)}%</div>
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
