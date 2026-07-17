"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Shield, Target, Trophy } from "lucide-react";
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

export interface ParlayView {
  id: string;
  matchDate: string;
  type: string; // daily_best | safe | value
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
}

const TYPE_META: Record<string, { label: string; icon: typeof Trophy; color: string }> = {
  daily_best: { label: "Daily Best Parlay", icon: Trophy, color: "text-amber-500" },
  safe: { label: "Safe Accumulator", icon: Shield, color: "text-emerald-500" },
  value: { label: "Value Bet Parlay", icon: Target, color: "text-blue-500" },
};

export function ParlayCard({ parlay }: { parlay: ParlayView }) {
  const meta = TYPE_META[parlay.type] ?? TYPE_META.daily_best;
  const Icon = meta.icon;
  const ev = parlay.expectedValue;
  const isValue = parlay.type === "value";
  const hasKelly = parlay.recommendedStake !== null && parlay.recommendedStake !== undefined && parlay.recommendedStake > 0;

  return (
    <Card className={cn("overflow-hidden border-l-4", isValue ? "border-l-amber-400" : "border-l-primary")}>
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
            </div>
          </div>
          {parlay.evaluated && (
            <Badge variant={parlay.won ? "default" : "destructive"} className="text-xs">
              {parlay.won ? "WON" : "LOST"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {parlay.legs.slice(0, isValue ? 10 : 5).map((leg, i) => (
          <div
            key={leg.predictionId}
            className="flex items-center gap-3 py-2 px-3 rounded-md bg-muted/40 text-sm"
          >
            <div className="w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center shrink-0">
              {i + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{leg.matchLabel}</div>
              <div className="text-xs text-muted-foreground truncate">
                <span className="uppercase tracking-wide">{leg.market.replace(/_/g, " ")}:</span>{" "}
                <span className="font-medium">{leg.selection}</span>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="font-mono text-sm font-semibold">{leg.odds.toFixed(2)}</div>
              <div className="text-[10px] text-muted-foreground">{(leg.probability * 100).toFixed(0)}%</div>
            </div>
          </div>
        ))}
        {parlay.legs.length > (isValue ? 10 : 5) && (
          <div className="text-xs text-center text-muted-foreground py-1">
            +{parlay.legs.length - (isValue ? 10 : 5)} more legs
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
                Kelly Stake
              </span>
              <span className="text-[10px] text-muted-foreground">
                1/4 Kelly · capped at 2% bankroll
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
