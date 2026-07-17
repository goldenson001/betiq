"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell,
} from "recharts";
import { TrendingUp, TrendingDown, Target, Trophy, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SnapshotView {
  date: string;
  totalPredictions: number;
  correctPredictions: number;
  winRate: number;
  roi: number;
  parlaysMade: number;
  parlaysWon: number;
  parlayRoi: number;
  winStreak: number;
  loseStreak: number;
  marketBreakdown: Record<string, { total: number; correct: number }>;
}

export interface SourceView {
  id: string;
  name: string;
  displayName: string;
  weight: number;
  accuracy: number;
  totalPredictions: number;
  correctPredictions: number;
  roi: number;
  enabled: boolean;
  lastScrapedAt: string | null;
}

export interface AggregatesView {
  totalPredictions: number;
  totalCorrect: number;
  aggregateWinRate: number;
  aggregateRoi: number;
  parlaysMade: number;
  parlaysWon: number;
  parlayWinRate: number;
}

export interface MarketAggView {
  [market: string]: { total: number; correct: number };
}

interface PerformanceDashboardProps {
  snapshots: SnapshotView[];
  sources: SourceView[];
  aggregates: AggregatesView;
  marketAgg: MarketAggView;
}

function Sparkline({
  data,
  dataKey,
  color,
  positiveColor,
  negativeColor,
}: {
  data: SnapshotView[];
  dataKey: keyof SnapshotView;
  color?: string;
  positiveColor?: string;
  negativeColor?: string;
}) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground italic">
        No historical data yet
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`grad-${String(dataKey)}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color ?? "#10b981"} stopOpacity={0.6} />
            <stop offset="100%" stopColor={color ?? "#10b981"} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" hide />
        <YAxis hide domain={["auto", "auto"]} />
        <Tooltip
          contentStyle={{
            backgroundColor: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: "0.5rem",
            fontSize: "12px",
          }}
          labelStyle={{ color: "var(--popover-foreground)" }}
          formatter={(v: number) => [(v * 100).toFixed(2) + "%", String(dataKey)]}
        />
        <Area
          type="monotone"
          dataKey={dataKey as string}
          stroke={color ?? "#10b981"}
          strokeWidth={2}
          fill={`url(#grad-${String(dataKey)})`}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function StatCard({
  label,
  value,
  delta,
  icon: Icon,
  trend,
}: {
  label: string;
  value: string;
  delta?: string;
  icon: typeof TrendingUp;
  trend?: "up" | "down" | "neutral";
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4 px-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </p>
            <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
            {delta && (
              <p
                className={cn(
                  "text-xs mt-1 flex items-center gap-1",
                  trend === "up" && "text-emerald-500",
                  trend === "down" && "text-rose-500",
                  trend === "neutral" && "text-muted-foreground"
                )}
              >
                {trend === "up" && <TrendingUp className="h-3 w-3" />}
                {trend === "down" && <TrendingDown className="h-3 w-3" />}
                {delta}
              </p>
            )}
          </div>
          <div className="p-2 rounded-md bg-primary/10">
            <Icon className="h-4 w-4 text-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function PerformanceDashboard({
  snapshots,
  sources,
  aggregates,
  marketAgg,
}: PerformanceDashboardProps) {
  const winRatePct = (aggregates.aggregateWinRate * 100).toFixed(1);
  const roiPct = (aggregates.aggregateRoi * 100).toFixed(2);
  const parlayWinRatePct = (aggregates.parlayWinRate * 100).toFixed(1);

  // Best/worst markets
  const marketStats = Object.entries(marketAgg)
    .map(([market, v]) => ({
      market,
      total: v.total,
      correct: v.correct,
      winRate: v.total > 0 ? v.correct / v.total : 0,
    }))
    .sort((a, b) => b.winRate - a.winRate)
    .filter((m) => m.total >= 1);

  const chartData = snapshots.map((s) => ({
    date: s.date.slice(5), // MM-DD
    winRate: s.winRate,
    roi: s.roi,
    parlayRoi: s.parlayRoi,
  }));

  return (
    <div className="space-y-5">
      {/* Top stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Predictions"
          value={aggregates.totalPredictions.toLocaleString()}
          delta={`${aggregates.totalCorrect.toLocaleString()} correct`}
          icon={Activity}
          trend="neutral"
        />
        <StatCard
          label="Aggregate Win Rate"
          value={`${winRatePct}%`}
          delta={snapshots.length > 0 ? `${snapshots.length} days tracked` : "Awaiting data"}
          icon={Target}
          trend={aggregates.aggregateWinRate >= 0.5 ? "up" : "down"}
        />
        <StatCard
          label="ROI (flat 1u)"
          value={`${roiPct}%`}
          delta={aggregates.aggregateRoi >= 0 ? "Profitable" : "Below breakeven"}
          icon={TrendingUp}
          trend={aggregates.aggregateRoi >= 0 ? "up" : "down"}
        />
        <StatCard
          label="Parlay Win Rate"
          value={`${parlayWinRatePct}%`}
          delta={`${aggregates.parlaysWon}/${aggregates.parlaysMade} parlays`}
          icon={Trophy}
          trend={aggregates.parlayWinRate >= 0.3 ? "up" : "down"}
        />
      </div>

      {/* Win rate & ROI trend */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Win Rate & ROI Trend</CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-sm text-muted-foreground italic">
              No historical data yet — predictions start tracking after matches finish.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 5, right: 15, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="var(--muted-foreground)"
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: "0.5rem",
                    fontSize: "12px",
                  }}
                  formatter={(v: number, name: string) => [`${(v * 100).toFixed(2)}%`, name]}
                />
                <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="winRate"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  name="Win Rate"
                  dot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="roi"
                  stroke="var(--chart-2)"
                  strokeWidth={2}
                  name="ROI"
                  dot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="parlayRoi"
                  stroke="var(--chart-4)"
                  strokeWidth={2}
                  name="Parlay ROI"
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Per-market accuracy */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-Market Accuracy</CardTitle>
          </CardHeader>
          <CardContent>
            {marketStats.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-sm text-muted-foreground italic">
                No market data yet
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(200, marketStats.length * 32)}>
                <BarChart
                  data={marketStats}
                  layout="vertical"
                  margin={{ top: 5, right: 15, bottom: 5, left: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
                  <XAxis
                    type="number"
                    domain={[0, 1]}
                    tick={{ fontSize: 11 }}
                    stroke="var(--muted-foreground)"
                    tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                  />
                  <YAxis
                    type="category"
                    dataKey="market"
                    tick={{ fontSize: 10 }}
                    stroke="var(--muted-foreground)"
                    width={110}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: "0.5rem",
                      fontSize: "12px",
                    }}
                    formatter={(v: number) => `${(v * 100).toFixed(1)}%`}
                  />
                  <Bar dataKey="winRate" radius={[0, 4, 4, 0]}>
                    {marketStats.map((m) => (
                      <Cell
                        key={m.market}
                        fill={
                          m.winRate >= 0.6
                            ? "var(--chart-1)"
                            : m.winRate >= 0.45
                            ? "var(--chart-2)"
                            : "var(--destructive)"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Source accuracy table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Source Performance</CardTitle>
          </CardHeader>
          <CardContent>
            {sources.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-sm text-muted-foreground italic">
                No sources initialized yet
              </div>
            ) : (
              <div className="space-y-2">
                {sources.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-3 py-2 px-3 rounded-md border border-border/50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm">{s.displayName}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.totalPredictions} predictions · {s.correctPredictions} correct
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold tabular-nums">
                        {(s.accuracy * 100).toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-muted-foreground">accuracy</div>
                    </div>
                    <div className="w-16 shrink-0">
                      <div className="text-xs text-muted-foreground mb-0.5">weight</div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${s.weight * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Sparklines for win rate / ROI */}
      <div className="grid sm:grid-cols-2 gap-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Daily Win Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-24">
              <Sparkline data={snapshots} dataKey="winRate" color="var(--chart-1)" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Daily ROI</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-24">
              <Sparkline data={snapshots} dataKey="roi" color="var(--chart-2)" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
