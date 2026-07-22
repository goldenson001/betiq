"use client";

/**
 * WonParlaysHistory
 *
 * Owner-private component (gated by the `betiq_owner` cookie server-side).
 * Renders the historical record of every won parlay so the owner can do
 * human evaluation:
 *   - Which tier wins most? (filterable)
 *   - How often does each leg-pattern win? (the legs are listed for each row)
 *   - What was the combined odds vs. probability vs. realized ROI?
 *
 * Data source: GET /api/admin/parlays/won (owner-gated).
 *
 * Every parlay shown is:
 *   - DATED     (matchDate is shown as a badge on every row)
 *   - SETTLED   (only evaluated=true AND won=true rows are returned by the API)
 *   - SORTED    (orderBy matchDate desc, then createdAt desc — newest first)
 *
 * The component is intentionally self-contained — it owns its own query and
 * behaves exactly like the Performance tab: it just shows for the owner,
 * silently 404s for everyone else.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Trophy,
  TrendingUp,
  Loader2,
  ChevronDown,
  ChevronRight,
  Calendar,
  Filter,
  Brain,
  Target,
  Shield,
  Flame,
  Sparkles,
  CheckCircle2,
  ArrowDownWideNarrow,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types (mirror /api/admin/parlays/won) ─────────────────────────────────
interface WonParlayLeg {
  predictionId: string;
  matchId: string;
  matchLabel: string;
  market: string;
  selection: string;
  odds: number;
  probability: number;
  confidence: number;
}

interface WonParlayView {
  id: string;
  matchDate: string;
  type: string;
  legsCount: number;
  combinedProbability: number;
  combinedOdds: number;
  confidence: number;
  expectedValue: number;
  kellyFraction: number | null;
  recommendedStake: number | null;
  mlScore: number | null;
  mlAdjustedProbability: number | null;
  mlSampleCount: number | null;
  evaluated: boolean;
  won: boolean | null;
  createdAt: string;
  legs: WonParlayLeg[];
  settlement?: {
    legsWon: number | null;
    legsLost: number | null;
    legsVoid: number | null;
    actualReturn: number | null;
    realizedRoi: number | null;
    settledAt: string | null;
    notes: string | null;
  } | null;
}

interface WonParlaysResponse {
  ok: boolean;
  count: number;
  parlays: WonParlayView[];
}

// ── Tier metadata (subset of parlay-card.tsx — kept local so the component is
//    self-contained for the admin view) ────────────────────────────────────
const TIER_META: Record<
  string,
  { label: string; icon: typeof Trophy; color: string }
> = {
  safest: { label: "Safest Bet", icon: Shield, color: "text-emerald-500" },
  medium_risk: { label: "Medium Risk", icon: TrendingUp, color: "text-blue-500" },
  high_risk: { label: "High Risk", icon: Flame, color: "text-amber-500" },
  mega_odds: { label: "Mega Odds", icon: Sparkles, color: "text-fuchsia-500" },
  odds_3_a: { label: "Target Odds 3 — A", icon: Target, color: "text-cyan-500" },
  odds_3_b: { label: "Target Odds 3 — B", icon: Target, color: "text-teal-500" },
  odds_5_a: { label: "Target Odds 5 — A", icon: Target, color: "text-indigo-500" },
  odds_5_b: { label: "Target Odds 5 — B", icon: Target, color: "text-violet-500" },
  daily_best: { label: "Daily Best", icon: Trophy, color: "text-amber-500" },
  safe: { label: "Safe Accumulator", icon: Shield, color: "text-emerald-500" },
  value: { label: "Value Parlay", icon: TrendingUp, color: "text-blue-500" },
};

function tierMeta(t: string) {
  return TIER_META[t] ?? { label: t, icon: Trophy, color: "text-muted-foreground" };
}

// ── Component ──────────────────────────────────────────────────────────────
// Auto-fetches — no `enabled` flag, no lock. The owner cookie gates this
// server-side: regular visitors get 404 from /api/admin/parlays/won and the
// query errors out (rendered as a clean "not available" message). For the
// site owner (who has the cookie), this behaves exactly like the Performance
// tab — it just shows.
export function WonParlaysHistory() {
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const query = useQuery<WonParlaysResponse>({
    queryKey: ["owner", "parlays", "won"],
    queryFn: async () => {
      const r = await fetch("/api/admin/parlays/won?limit=1000");
      // 404 = not owner (no cookie). Surface a clean message instead of an error.
      if (r.status === 404) {
        throw new Error("NOT_OWNER");
      }
      if (r.status === 401) {
        throw new Error("Session expired — re-visit /api/owner/unlock?token=YOUR_TOKEN.");
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<WonParlaysResponse>;
    },
    staleTime: 60_000,
    retry: false,
  });

  // ── Derived stats ────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const all = query.data?.parlays ?? [];
    const totalWon = all.length;
    const totalLegs = all.reduce((s, p) => s + p.legsCount, 0);
    const avgOdds =
      totalWon > 0 ? all.reduce((s, p) => s + p.combinedOdds, 0) / totalWon : 0;
    const avgProb =
      totalWon > 0
        ? all.reduce((s, p) => s + p.combinedProbability, 0) / totalWon
        : 0;
    const avgConfidence =
      totalWon > 0 ? all.reduce((s, p) => s + p.confidence, 0) / totalWon : 0;
    // Realized ROI from PickAudit where available
    const settled = all.filter((p) => p.settlement && p.settlement.realizedRoi !== null);
    const avgRealizedRoi =
      settled.length > 0
        ? settled.reduce((s, p) => s + (p.settlement!.realizedRoi ?? 0), 0) / settled.length
        : null;

    // Per-tier counts
    const byTier = new Map<string, number>();
    for (const p of all) {
      byTier.set(p.type, (byTier.get(p.type) ?? 0) + 1);
    }
    const tierRows = Array.from(byTier.entries())
      .map(([tier, count]) => ({ tier, count, label: tierMeta(tier).label }))
      .sort((a, b) => b.count - a.count);

    return {
      totalWon,
      totalLegs,
      avgOdds,
      avgProb,
      avgConfidence,
      avgRealizedRoi,
      tierRows,
    };
  }, [query.data]);

  // ── Filtered rows (apply tier filter + text search) ──────────────────
  const filtered = useMemo(() => {
    const all = query.data?.parlays ?? [];
    const q = search.trim().toLowerCase();
    return all.filter((p) => {
      if (tierFilter !== "all" && p.type !== tierFilter) return false;
      if (!q) return true;
      // Search across match labels, market, selection
      const haystack = p.legs
        .map((l) => `${l.matchLabel} ${l.market} ${l.selection}`)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [query.data, tierFilter, search]);

  // ── Render ───────────────────────────────────────────────────────────
  // NOT_OWNER: visitor doesn't have the owner cookie. This only happens when
  // a non-owner somehow navigates to the Won History tab (e.g. URL state).
  // Show a clean "not available" message — no leak about why.
  if (query.isError && (query.error as Error)?.message === "NOT_OWNER") {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Trophy className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium">No won parlay history available</p>
          <p className="text-xs text-muted-foreground mt-1">
            This view is private to the site owner.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (query.isLoading) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-3 text-violet-500" />
          <p className="text-sm text-muted-foreground">Loading won parlay history…</p>
        </CardContent>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card className="border-rose-400/40 bg-rose-500/5">
        <CardContent className="py-8 text-center text-sm space-y-1">
          <p className="font-medium text-rose-700 dark:text-rose-300">
            Failed to load won parlay history
          </p>
          <p className="text-xs text-muted-foreground">
            {(query.error as Error)?.message ?? "Unknown error"}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => query.refetch()}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!query.data || query.data.count === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Trophy className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium">No won parlays yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Once a parlay is settled as <strong>won</strong>, it will appear here
            with full details — date, legs, odds, ML score, and settlement
            outcome — so you can do human evaluation of which tiers and patterns
            win most often.
          </p>
          <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
            <Badge variant="outline" className="text-[10px] gap-1">
              <Calendar className="h-3 w-3" /> Dated
            </Badge>
            <Badge variant="outline" className="text-[10px] gap-1">
              <CheckCircle2 className="h-3 w-3" /> Settled
            </Badge>
            <Badge variant="outline" className="text-[10px] gap-1">
              <ArrowDownWideNarrow className="h-3 w-3" /> Sorted (newest first)
            </Badge>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Guarantees banner ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
        <Badge variant="outline" className="gap-1 text-[10px] border-emerald-400/40 text-emerald-700 dark:text-emerald-300">
          <Calendar className="h-3 w-3" /> Every row dated
        </Badge>
        <Badge variant="outline" className="gap-1 text-[10px] border-emerald-400/40 text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-3 w-3" /> Settled &amp; won only
        </Badge>
        <Badge variant="outline" className="gap-1 text-[10px] border-emerald-400/40 text-emerald-700 dark:text-emerald-300">
          <ArrowDownWideNarrow className="h-3 w-3" /> Sorted by date (newest first)
        </Badge>
        <span className="ml-auto font-mono">
          {query.data.count} {query.data.count === 1 ? "parlay" : "parlays"} archived
        </span>
      </div>

      {/* ── Summary stats ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <StatCard
          label="Won Parlays"
          value={String(stats.totalWon)}
          icon={<Trophy className="h-4 w-4 text-amber-500" />}
        />
        <StatCard
          label="Total Legs"
          value={String(stats.totalLegs)}
          icon={<Target className="h-4 w-4 text-cyan-500" />}
        />
        <StatCard
          label="Avg Odds"
          value={stats.avgOdds.toFixed(2)}
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
        />
        <StatCard
          label="Avg Win Prob"
          value={`${(stats.avgProb * 100).toFixed(1)}%`}
          icon={<Shield className="h-4 w-4 text-blue-500" />}
        />
        <StatCard
          label="Avg Confidence"
          value={`${stats.avgConfidence.toFixed(0)}%`}
          icon={<Brain className="h-4 w-4 text-violet-500" />}
        />
        <StatCard
          label="Avg Realized ROI"
          value={
            stats.avgRealizedRoi !== null
              ? `${(stats.avgRealizedRoi * 100).toFixed(1)}%`
              : "—"
          }
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />}
        />
      </div>

      {/* ── Per-tier breakdown ────────────────────────────────────────── */}
      {stats.tierRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5" />
              Won parlays by tier
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {stats.tierRows.map((row) => {
                const meta = tierMeta(row.tier);
                const Icon = meta.icon;
                return (
                  <Badge
                    key={row.tier}
                    variant="outline"
                    className="gap-1 text-xs"
                  >
                    <Icon className={cn("h-3 w-3", meta.color)} />
                    {row.label}
                    <span className="ml-1 font-mono font-bold">{row.count}</span>
                  </Badge>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Filters ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={tierFilter} onValueChange={setTierFilter}>
          <SelectTrigger className="h-9 w-[220px] text-xs">
            <SelectValue placeholder="All tiers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tiers</SelectItem>
            {Object.entries(TIER_META).map(([key, meta]) => (
              <SelectItem key={key} value={key}>
                {meta.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Search by team / market / selection…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm h-9 text-xs"
        />
        <Badge variant="secondary" className="text-xs">
          Showing {filtered.length} of {query.data.count}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-9 ml-auto"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Calendar className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {/* ── Won parlay rows ───────────────────────────────────────────── */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-xs text-muted-foreground">
              No won parlays match the current filter.
            </CardContent>
          </Card>
        ) : (
          filtered.map((p) => <WonParlayRow key={p.id} parlay={p} />)
        )}
      </div>
    </div>
  );
}

// ── Single won parlay row (collapsible details) ────────────────────────────
function WonParlayRow({ parlay }: { parlay: WonParlayView }) {
  const [open, setOpen] = useState(false);
  const meta = tierMeta(parlay.type);
  const Icon = meta.icon;
  const settled = parlay.settlement;
  const hasRealizedRoi = settled?.realizedRoi !== null && settled?.realizedRoi !== undefined;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border border-emerald-400/40 bg-emerald-500/5 rounded-lg overflow-hidden"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-emerald-500/10 transition-colors"
        >
          <div className="shrink-0">
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <Icon className={cn("h-5 w-5 shrink-0", meta.color)} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{meta.label}</span>
              <Badge className="text-[10px] gap-0.5 bg-emerald-600 text-white">
                <Trophy className="h-3 w-3" /> WON
              </Badge>
              <Badge variant="outline" className="text-[10px] gap-1 font-mono">
                <Calendar className="h-3 w-3" />
                {parlay.matchDate}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3 flex-wrap">
              <span>{parlay.legsCount} legs</span>
              <span className="font-mono">Odds {parlay.combinedOdds.toFixed(2)}</span>
              <span>Prob {(parlay.combinedProbability * 100).toFixed(1)}%</span>
              <span>Conf {parlay.confidence.toFixed(0)}%</span>
              {parlay.mlScore !== null && (
                <span className="flex items-center gap-1 text-violet-600 dark:text-violet-300">
                  <Brain className="h-3 w-3" />
                  ML {(parlay.mlScore * 100).toFixed(0)}%
                </span>
              )}
              {hasRealizedRoi && (
                <span
                  className={cn(
                    "font-semibold",
                    (settled!.realizedRoi ?? 0) > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400"
                  )}
                >
                  ROI {(settled!.realizedRoi! * 100).toFixed(1)}%
                </span>
              )}
            </div>
          </div>
          <div className="hidden sm:block text-right shrink-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Combined Odds
            </div>
            <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400 font-mono">
              {parlay.combinedOdds.toFixed(2)}
            </div>
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-emerald-400/20 px-3 py-3 space-y-3">
          {/* Legs */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Legs ({parlay.legs.length})
            </div>
            {parlay.legs.map((leg, i) => (
              <div
                key={leg.predictionId}
                className="flex items-center gap-3 py-1.5 px-2 rounded-md text-sm bg-emerald-500/10 border border-emerald-500/30"
              >
                <div className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-xs font-bold flex items-center justify-center shrink-0">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{leg.matchLabel}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    <span className="uppercase tracking-wide">
                      {leg.market.replace(/_/g, " ")}:
                    </span>{" "}
                    <span className="font-medium">{leg.selection}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-sm font-semibold">
                    {leg.odds.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {(leg.probability * 100).toFixed(0)}%
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Settlement detail */}
          {settled && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-emerald-400/20">
              <Field label="Legs Won" value={settled.legsWon ?? "—"} />
              <Field label="Legs Lost" value={settled.legsLost ?? "—"} />
              <Field label="Legs Void" value={settled.legsVoid ?? "—"} />
              <Field
                label="Actual Return"
                value={
                  settled.actualReturn !== null
                    ? settled.actualReturn.toFixed(2)
                    : "—"
                }
              />
              {settled.settledAt && (
                <Field
                  label="Settled At"
                  value={new Date(settled.settledAt).toLocaleString()}
                />
              )}
              {settled.notes && (
                <div className="col-span-2 sm:col-span-4 text-xs text-muted-foreground italic">
                  Notes: {settled.notes}
                </div>
              )}
            </div>
          )}

          {/* ML signals snapshot */}
          {parlay.mlScore !== null && (
            <div className="pt-2 border-t border-emerald-400/20 text-xs text-muted-foreground flex flex-wrap gap-3">
              <span className="flex items-center gap-1">
                <Brain className="h-3 w-3 text-violet-500" />
                ML score: <strong>{(parlay.mlScore * 100).toFixed(1)}%</strong>
              </span>
              {parlay.mlAdjustedProbability !== null && (
                <span>
                  ML-adjusted prob:{" "}
                  <strong>{(parlay.mlAdjustedProbability * 100).toFixed(1)}%</strong>
                </span>
              )}
              {parlay.mlSampleCount !== null && parlay.mlSampleCount > 0 && (
                <span>
                  Learning samples: <strong>{parlay.mlSampleCount}</strong>
                </span>
              )}
              {parlay.kellyFraction !== null && (
                <span>
                  Kelly fraction:{" "}
                  <strong className="font-mono">
                    {(parlay.kellyFraction * 100).toFixed(2)}%
                  </strong>
                </span>
              )}
              {parlay.recommendedStake !== null && (
                <span>
                  Recommended stake:{" "}
                  <strong className="font-mono">
                    {(parlay.recommendedStake * 100).toFixed(2)}%
                  </strong>
                </span>
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="text-lg font-bold mt-1 font-mono">{value}</div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-mono font-medium">{value}</div>
    </div>
  );
}
