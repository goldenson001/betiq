"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Wallet, AlertTriangle } from "lucide-react";

interface Snapshot {
  date: string;
  winRate: number;
  roi: number;
  kellyRoi?: number;
  calibrationError?: number;
  avgClv?: number;
  totalPredictions: number;
  correctPredictions: number;
}

interface BankrollSimulatorProps {
  snapshots: Snapshot[];
  /** Today's recommended stake sum (as fraction of bankroll). */
  todayExposure?: number;
  /** Drawdown state — affects projected returns. */
  drawdownState?: "normal" | "degraded" | "halted";
  drawdownReason?: string;
}

/**
 * C1: Bankroll Simulator Panel
 * ─────────────────────────────
 * Translates abstract Kelly % and model performance into a money story:
 *   - User inputs their bankroll size
 *   - We compute today's projected stake total in €
 *   - We project 30-day P&L distribution using historical kellyRoi
 *   - We estimate max drawdown using stdev of rolling kellyRoi
 *
 * All numbers are derived from existing PerformanceSnapshot data — no new
 * backend queries needed.
 */
export function BankrollSimulator({
  snapshots,
  todayExposure,
  drawdownState = "normal",
  drawdownReason,
}: BankrollSimulatorProps) {
  const [bankroll, setBankroll] = useState<number>(1000);
  const [kellyFraction, setKellyFraction] = useState<number>(25); // percent

  const stats = useMemo(() => {
    if (snapshots.length === 0) return null;
    const rois = snapshots.map((s) => s.kellyRoi ?? 0);
    const meanRoi = rois.reduce((s, r) => s + r, 0) / rois.length;
    const variance = rois.reduce((s, r) => s + (r - meanRoi) ** 2, 0) / rois.length;
    const stdevRoi = Math.sqrt(variance);

    // Projected daily P&L = bankroll × kellyFraction × meanRoi
    const dailyStake = bankroll * 0.15 * (kellyFraction / 25); // assume 15% daily exposure
    const projectedDailyPnl = dailyStake * meanRoi;

    // 30-day projection (compounded)
    const dailyRate = meanRoi * (kellyFraction / 25);
    const projected30DayGrowth = Math.pow(1 + dailyRate * 0.15, 30) - 1;
    const projected30DayPnl = bankroll * projected30DayGrowth;

    // Max drawdown estimate: 2 × stdev × sqrt(30) (worst-case 30-day window)
    const maxDrawdownPct = 2 * stdevRoi * Math.sqrt(30) * 0.15; // scale by exposure
    const maxDrawdownEur = bankroll * Math.min(0.50, Math.abs(maxDrawdownPct));

    // Today's projected stake (using actual exposure if available)
    const todayStakeEur = bankroll * (todayExposure ?? 0.15);

    // Drawdown multiplier effect
    const drawdownMultiplier = drawdownState === "halted" ? 0 : drawdownState === "degraded" ? 0.5 : 1.0;
    const adjustedTodayStakeEur = todayStakeEur * drawdownMultiplier;
    const adjustedProjectedDailyPnl = projectedDailyPnl * drawdownMultiplier;

    return {
      meanRoi,
      stdevRoi,
      dailyStake,
      projectedDailyPnl: adjustedProjectedDailyPnl,
      projected30DayPnl,
      maxDrawdownEur,
      todayStakeEur: adjustedTodayStakeEur,
      drawdownMultiplier,
    };
  }, [snapshots, bankroll, kellyFraction, todayExposure, drawdownState]);

  if (!stats) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Wallet className="h-4 w-4" />
            Bankroll Simulator
          </CardTitle>
        </CardHeader>
        <CardContent className="py-6 text-center text-xs text-muted-foreground">
          No historical performance data yet. Run the pipeline for a few days to enable projections.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={drawdownState !== "normal" ? "border-amber-400" : ""}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wallet className="h-4 w-4" />
          Bankroll Simulator
          {drawdownState !== "normal" && (
            <Badge variant="outline" className="text-[9px] h-4 px-1 border-amber-500 text-amber-700 dark:text-amber-300 font-semibold">
              {drawdownState === "halted" ? "HALTED" : "DEGRADED"}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {drawdownState !== "normal" && drawdownReason && (
          <div className="flex items-start gap-2 p-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[11px]">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <span className="text-amber-800 dark:text-amber-200">{drawdownReason}</span>
          </div>
        )}

        {/* Inputs */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="bankroll" className="text-xs text-muted-foreground">
              Bankroll (€)
            </Label>
            <Input
              id="bankroll"
              type="number"
              min={1}
              step={50}
              value={bankroll}
              onChange={(e) => setBankroll(Math.max(1, Number(e.target.value) || 0))}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="kelly" className="text-xs text-muted-foreground">
              Kelly Fraction: {kellyFraction}%
            </Label>
            <Slider
              id="kelly"
              min={5}
              max={100}
              step={5}
              value={[kellyFraction]}
              onValueChange={(v) => setKellyFraction(v[0])}
              className="py-2"
            />
          </div>
        </div>

        {/* Outputs */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
              Today&apos;s Stake
            </div>
            <div className="font-bold text-sm tabular-nums">
              €{stats.todayStakeEur.toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {((stats.todayStakeEur / bankroll) * 100).toFixed(1)}% of bankroll
            </div>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
              Projected Daily P&L
            </div>
            <div className={"font-bold text-sm tabular-nums flex items-center gap-1 " +
              (stats.projectedDailyPnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
              {stats.projectedDailyPnl >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {stats.projectedDailyPnl >= 0 ? "+" : "−"}€{Math.abs(stats.projectedDailyPnl).toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground">
              avg kelly ROI {(stats.meanRoi * 100).toFixed(1)}%
            </div>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
              30-Day Projection
            </div>
            <div className={"font-bold text-sm tabular-nums " +
              (stats.projected30DayPnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
              {stats.projected30DayPnl >= 0 ? "+" : "−"}€{Math.abs(stats.projected30DayPnl).toFixed(0)}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {((stats.projected30DayPnl / bankroll) * 100).toFixed(1)}% growth
            </div>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
              Est. Max Drawdown
            </div>
            <div className="font-bold text-sm tabular-nums text-rose-600 dark:text-rose-400">
              −€{stats.maxDrawdownEur.toFixed(0)}
            </div>
            <div className="text-[10px] text-muted-foreground">
              worst 30-day window
            </div>
          </div>
        </div>

        <p className="text-[10px] text-muted-foreground italic">
          Projections based on trailing-30-day Kelly ROI × your bankroll × selected Kelly fraction.
          Drawdown estimate = 2σ × √30. Actual results may vary. Past performance is not indicative of future results.
        </p>
      </CardContent>
    </Card>
  );
}
