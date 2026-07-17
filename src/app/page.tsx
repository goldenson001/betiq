"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, addDays, subDays, parseISO } from "date-fns";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import {
  Calendar,
  RefreshCw,
  Sun,
  Moon,
  Trophy,
  Target,
  TrendingUp,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Zap,
  Globe,
  BarChart3,
  Loader2,
  Info,
  Shield,
  Clock,
} from "lucide-react";
import { useTheme } from "next-themes";
import { MatchCard, type MatchView } from "@/components/dashboard/match-card";
import { MatchDetailDialog, type MatchDetailView } from "@/components/dashboard/match-detail";
import { ParlayCard, type ParlayView, parlayTypeOrder } from "@/components/dashboard/parlay-card";
import {
  PerformanceDashboard,
  type SnapshotView,
  type SourceView,
  type AggregatesView,
  type MarketAggView,
} from "@/components/dashboard/performance";
import { PredictionRow } from "@/components/dashboard/prediction-row";

interface MatchesResponse {
  date: string;
  totalMatches: number;
  leagues: Array<{
    id: string;
    name: string;
    country: string;
    matchCount: number;
    matches: Array<{
      id: string;
      externalId: string;
      matchDate: string;
      kickoffBrussels: string;
      homeTeam: string;
      awayTeam: string;
      status: string;
      homeScore: number | null;
      awayScore: number | null;
      homeForm: string | null;
      awayForm: string | null;
      h2hJson: string | null;
      league: { id: string; name: string; country: string } | null;
      predictions: Array<{
        id: string;
        market: string;
        selection: string;
        confidence: number;
        probability: number;
        fairOdds: number;
        bookOdds: number | null;
        edge: number | null;
        isTopPick: boolean;
        isValueBet: boolean;
        isSafePick?: boolean;
        isSafeHighOdds?: boolean;
        consensusSources?: number;
        recommendedStake?: number | null;
        clv?: number | null;
        sourcesJson: string | null;
      }>;
    }>;
  }>;
}

interface ParlaysResponse {
  ok: boolean;
  date: string;
  parlays: ParlayView[];
}

interface PerformanceResponse {
  ok: boolean;
  snapshots: SnapshotView[];
  sources: SourceView[];
  aggregates: AggregatesView;
  marketAgg: MarketAggView;
}

interface StatsResponse {
  ok: boolean;
  date: string;
  stats: {
    totalMatches: number;
    totalPredictions: number;
    totalParlays: number;
    leaguesCovered: number;
    topPicksCount: number;
    valueBetsCount: number;
    safePicksCount: number;
    safeHighOddsCount: number;
  };
  leagueCounts: Array<{ name: string; count: number }>;
  topPicks: Array<{
    id: string;
    match: string;
    market: string;
    selection: string;
    confidence: number;
    probability?: number;
    bookOdds: number | null;
    edge: number | null;
    isSafePick?: boolean;
    isSafeHighOdds?: boolean;
    consensusSources?: number;
    recommendedStake?: number | null;
    clv?: number | null;
  }>;
  valueBets: Array<{
    id: string;
    match: string;
    league?: string | null;
    kickoffBrussels?: string | null;
    market: string;
    selection: string;
    confidence: number;
    probability?: number;
    bookOdds: number | null;
    edge: number | null;
    isSafePick?: boolean;
    isSafeHighOdds?: boolean;
    isTopPick?: boolean;
    isValueBet?: boolean;
    consensusSources?: number;
    recommendedStake?: number | null;
    clv?: number | null;
  }>;
  safePicks?: Array<{
    id: string;
    match: string;
    league?: string | null;
    kickoffBrussels?: string | null;
    market: string;
    selection: string;
    confidence: number;
    probability?: number;
    bookOdds: number | null;
    edge: number | null;
    isSafePick?: boolean;
    isTopPick?: boolean;
    consensusSources?: number;
    recommendedStake?: number | null;
    clv?: number | null;
  }>;
  safeHighOddsPicks?: Array<{
    id: string;
    match: string;
    market: string;
    selection: string;
    confidence: number;
    probability?: number;
    bookOdds: number | null;
    edge: number | null;
    isSafePick?: boolean;
    consensusSources?: number;
    recommendedStake?: number | null;
    clv?: number | null;
  }>;
  sources: SourceView[];
  recentScrapeLogs: Array<{
    id: string;
    source: string;
    startedAt: string;
    finishedAt: string | null;
    matchesFound: number;
    status: string;
    error: string | null;
  }>;
}

function brusselsToday(): string {
  // We rely on the server to set the date — for the client we use local date
  // which approximates Brussels in EU tz. (Good enough for nav.)
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function shiftDate(dateStr: string, days: number): string {
  const d = parseISO(dateStr);
  return format(addDays(d, days), "yyyy-MM-dd");
}

export default function Home() {
  const queryClient = useQueryClient();
  const [date, setDate] = useState<string>(brusselsToday());
  const [activeTab, setActiveTab] = useState("matches");
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [matchDetail, setMatchDetail] = useState<MatchDetailView | null>(null);
  const [matchDetailOpen, setMatchDetailOpen] = useState(false);
  const [leagueFilter, setLeagueFilter] = useState<string>("");
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // ── Queries ─────────────────────────────────────────────────────────────
  const matchesQuery = useQuery<MatchesResponse>({
    queryKey: ["matches", date, leagueFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ date });
      if (leagueFilter) params.set("league", leagueFilter);
      const r = await fetch(`/api/matches?${params}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        const msg = body?.error || body?.hint || `HTTP ${r.status}`;
        throw new Error(msg);
      }
      return r.json() as Promise<MatchesResponse>;
    },
    staleTime: 60_000,
  });

  // ── Auto-fetch tomorrow (or any future date) when navigating forward ───────
  // When the user clicks the right arrow to view a future date that has no
  // matches yet, automatically trigger the scrape→predict→parlay pipeline so
  // matches become visible without manually clicking "Refresh Data".
  const [autoFetching, setAutoFetching] = useState(false);
  const todayStr = brusselsToday();
  const isFutureOrToday = date >= todayStr;
  const matchesEmpty =
    !matchesQuery.isLoading &&
    !matchesQuery.isError &&
    matchesQuery.data &&
    matchesQuery.data.totalMatches === 0;

  useEffect(() => {
    let cancelled = false;
    async function autoFetch() {
      if (!isFutureOrToday || !matchesEmpty || autoFetching) return;
      setAutoFetching(true);
      try {
        const r = await fetch(`/api/trigger?phase=all&date=${date}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await r.json();
        // Invalidate the matches query so the UI refreshes with new data
        queryClient.invalidateQueries({ queryKey: ["matches", date] });
        queryClient.invalidateQueries({ queryKey: ["stats", date] });
        queryClient.invalidateQueries({ queryKey: ["parlays", date] });
        toast.success(`Fetched matches for ${date}`);
      } catch (err) {
        toast.error(`Auto-fetch failed: ${(err as Error).message}`, { duration: 6000 });
      } finally {
        if (!cancelled) setAutoFetching(false);
      }
    }
    autoFetch();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, isFutureOrToday, matchesEmpty]);

  const statsQuery = useQuery<StatsResponse>({
    queryKey: ["stats", date],
    queryFn: async () => {
      const r = await fetch(`/api/stats?date=${date}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${r.status}`);
      }
      return r.json() as Promise<StatsResponse>;
    },
    staleTime: 60_000,
  });

  const parlaysQuery = useQuery<ParlaysResponse>({
    queryKey: ["parlays", date],
    queryFn: async () => {
      const r = await fetch(`/api/parlays?date=${date}`);
      if (!r.ok) throw new Error("Failed to load parlays");
      return r.json() as Promise<ParlaysResponse>;
    },
    staleTime: 60_000,
  });

  const performanceQuery = useQuery<PerformanceResponse>({
    queryKey: ["performance", 90],
    queryFn: async () => {
      const r = await fetch(`/api/performance?days=90`);
      if (!r.ok) throw new Error("Failed to load performance");
      return r.json() as Promise<PerformanceResponse>;
    },
    staleTime: 5 * 60_000,
  });

  // ── Mutations ───────────────────────────────────────────────────────────
  const triggerPipeline = useMutation({
    mutationFn: async (phase: string) => {
      const r = await fetch(`/api/trigger?phase=${phase}&date=${date}`, { method: "GET" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        const msg = body?.error || body?.hint || `HTTP ${r.status}`;
        throw new Error(msg);
      }
      return r.json();
    },
    onSuccess: (_data, phase) => {
      toast.success(`Pipeline phase "${phase}" completed`);
      queryClient.invalidateQueries({ queryKey: ["matches"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      queryClient.invalidateQueries({ queryKey: ["parlays"] });
      queryClient.invalidateQueries({ queryKey: ["performance"] });
    },
    onError: (err: Error) => {
      toast.error(`Pipeline failed: ${err.message}`, { duration: 8000 });
    },
  });

  // ── Handlers ────────────────────────────────────────────────────────────
  const openMatch = useCallback(
    async (m: MatchView) => {
      setSelectedMatchId(m.id);
      setMatchDetailOpen(true);
      try {
        const r = await fetch(`/api/match/${m.id}`);
        if (!r.ok) throw new Error("Failed to load match");
        const data = await r.json();
        setMatchDetail(data.match as MatchDetailView);
      } catch (err) {
        toast.error(`Failed to load match: ${(err as Error).message}`);
      }
    },
    []
  );

  const matches = useMemo(() => {
    if (!matchesQuery.data) return [];
    return matchesQuery.data.leagues.flatMap((l) =>
      l.matches.map((m) => ({ ...m, league: { id: l.id, name: l.name, country: l.country } }))
    );
  }, [matchesQuery.data]);

  const totalMatches = matchesQuery.data?.totalMatches ?? 0;
  const totalPredictions = statsQuery.data?.stats.totalPredictions ?? 0;
  const leaguesCovered = statsQuery.data?.stats.leaguesCovered ?? 0;

  // Render
  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="container mx-auto px-3 sm:px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-sm shrink-0">
              <Trophy className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-bold leading-none truncate">BetIQ</h1>
              <p className="text-[10px] sm:text-xs text-muted-foreground leading-none mt-0.5 hidden sm:block">
                AI Football Predictions · Self-Learning
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerPipeline.mutate("all")}
              disabled={triggerPipeline.isPending}
              className="gap-1.5 text-xs"
            >
              {triggerPipeline.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">Refresh Data</span>
              <span className="sm:hidden">Sync</span>
            </Button>
            {mounted && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="h-8 w-8"
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 container mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-5">
        {/* Live data banner */}
        <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-xs flex items-start gap-2">
          <Info className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
          <div className="text-emerald-900 dark:text-emerald-200">
            <strong className="font-semibold">Live ESPN data.</strong> Today's fixtures, team form, head-to-head records,
            and DraftKings odds are pulled in real time from the ESPN Soccer API. PredictZ, WinDrawWin, and StatArea
            consensus predictions are layered on top when reachable. The confidence engine, parlay builder, value-bet
            finder, and self-learning feedback loop all run end-to-end on the resulting data.
          </div>
        </div>

        {/* Date navigator */}
        <Card className="overflow-hidden">
          <CardContent className="p-3 sm:p-4 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setDate(shiftDate(date, -1))}
                aria-label="Previous day"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="flex items-center gap-2 px-2">
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono font-semibold text-sm sm:text-base">{date}</span>
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  ({format(parseISO(date), "EEEE")})
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setDate(shiftDate(date, 1))}
                aria-label="Next day"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-8"
              onClick={() => setDate(brusselsToday())}
            >
              Today
            </Button>
            <div className="flex items-center gap-3 ml-auto flex-wrap">
              <Badge variant="secondary" className="gap-1 text-xs">
                <Globe className="h-3 w-3" />
                {leaguesCovered} leagues
              </Badge>
              <Badge variant="secondary" className="gap-1 text-xs">
                <Calendar className="h-3 w-3" />
                {totalMatches} matches
              </Badge>
              <Badge variant="secondary" className="gap-1 text-xs">
                <Zap className="h-3 w-3" />
                {totalPredictions} predictions
              </Badge>
              {statsQuery.data && statsQuery.data.stats.safeHighOddsCount > 0 && (
                <Badge variant="secondary" className="gap-1 text-xs border-cyan-400 text-cyan-700 dark:text-cyan-300">
                  <TrendingUp className="h-3 w-3" />
                  {statsQuery.data.stats.safeHighOddsCount} safe hi-odds
                </Badge>
              )}
              {statsQuery.data && statsQuery.data.stats.safePicksCount > 0 && (
                <Badge variant="secondary" className="gap-1 text-xs border-emerald-400 text-emerald-700 dark:text-emerald-300">
                  <Shield className="h-3 w-3" />
                  {statsQuery.data.stats.safePicksCount} safe
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <ScrollArea className="w-full whitespace-nowrap">
            <TabsList className="inline-flex w-auto sm:w-full sm:justify-start">
              <TabsTrigger value="matches" className="gap-1.5 text-xs sm:text-sm">
                <Calendar className="h-3.5 w-3.5" /> Matches
              </TabsTrigger>
              <TabsTrigger value="parlays" className="gap-1.5 text-xs sm:text-sm">
                <Trophy className="h-3.5 w-3.5" /> Parlays
              </TabsTrigger>
              <TabsTrigger value="safe-high-odds" className="gap-1.5 text-xs sm:text-sm">
                <TrendingUp className="h-3.5 w-3.5" /> Safe High-Odds
              </TabsTrigger>
              <TabsTrigger value="safe" className="gap-1.5 text-xs sm:text-sm">
                <Shield className="h-3.5 w-3.5" /> Safe Picks
              </TabsTrigger>
              <TabsTrigger value="value" className="gap-1.5 text-xs sm:text-sm">
                <Target className="h-3.5 w-3.5" /> Value Bets
              </TabsTrigger>
              <TabsTrigger value="performance" className="gap-1.5 text-xs sm:text-sm">
                <BarChart3 className="h-3.5 w-3.5" /> Performance
              </TabsTrigger>
            </TabsList>
          </ScrollArea>

          {/* Matches tab */}
          <TabsContent value="matches" className="space-y-4 mt-4">
            {/* League filter */}
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                placeholder="Filter by league (e.g. Premier, La Liga, Serie A)"
                value={leagueFilter}
                onChange={(e) => setLeagueFilter(e.target.value)}
                className="max-w-sm h-9 text-sm"
              />
              {leagueFilter && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-9"
                  onClick={() => setLeagueFilter("")}
                >
                  Clear
                </Button>
              )}
            </div>

            {matchesQuery.isLoading ? (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {Array.from({ length: 9 }).map((_, i) => (
                  <Skeleton key={i} className="h-48 rounded-lg" />
                ))}
              </div>
            ) : matchesQuery.isError ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground space-y-2">
                  <div>Failed to load matches.</div>
                  <div className="text-xs text-destructive">
                    {(matchesQuery.error as Error)?.message || "Unknown error"}
                  </div>
                  <div className="text-xs">
                    Click <strong>Refresh Data</strong> to retry, or visit{" "}
                    <a
                      href="/api/diagnose"
                      target="_blank"
                      rel="noreferrer"
                      className="underline text-blue-600 dark:text-blue-400"
                    >
                      /api/diagnose
                    </a>{" "}
                    to inspect the database connection.
                  </div>
                </CardContent>
              </Card>
            ) : matches.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Trophy className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium">
                    {autoFetching
                      ? `Fetching matches for ${date}...`
                      : `No matches found for ${date}`}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {autoFetching
                      ? "Pulling fixtures from ESPN, generating predictions, and building parlays. This takes 10–30 seconds."
                      : "Click Refresh Data to trigger the scrape → predict → parlay pipeline."}
                  </p>
                  {autoFetching && (
                    <div className="mt-3 flex items-center justify-center gap-2 text-xs text-primary">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Running pipeline...</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-6">
                {matchesQuery.data!.leagues.map((league) => (
                  <div key={league.id}>
                    <div className="flex items-center justify-between mb-2 px-1">
                      <h3 className="text-sm font-semibold flex items-center gap-2">
                        <span className="text-xs px-1.5 py-0.5 bg-muted rounded font-mono uppercase tracking-wider">
                          {league.country.slice(0, 3)}
                        </span>
                        {league.name}
                      </h3>
                      <Badge variant="outline" className="text-[10px]">
                        {league.matchCount} {league.matchCount === 1 ? "match" : "matches"}
                      </Badge>
                    </div>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {league.matches.map((m) => (
                        <MatchCard
                          key={m.id}
                          match={{ ...m, league: { id: league.id, name: league.name, country: league.country } }}
                          onOpen={openMatch}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Parlays tab */}
          <TabsContent value="parlays" className="space-y-4 mt-4">
            {parlaysQuery.isLoading ? (
              <div className="grid sm:grid-cols-2 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-64 rounded-lg" />
                ))}
              </div>
            ) : parlaysQuery.isError ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  Failed to load parlays.
                </CardContent>
              </Card>
            ) : !parlaysQuery.data || parlaysQuery.data.parlays.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Trophy className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium">No parlays built for {date} yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Parlays are generated automatically after the prediction pipeline runs.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid sm:grid-cols-2 gap-4">
                {parlaysQuery.data.parlays
                  .slice()
                  .sort((a, b) => parlayTypeOrder(a.type) - parlayTypeOrder(b.type))
                  .map((p) => (
                    <ParlayCard key={p.id} parlay={p} />
                  ))}
              </div>
            )}
          </TabsContent>

          {/* Safe High-Odds tab — investment-grade picks with odds 1.50-2.50 */}
          <TabsContent value="safe-high-odds" className="space-y-3 mt-4">
            {statsQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-md" />
                ))}
              </div>
            ) : statsQuery.isError || !statsQuery.data || !statsQuery.data.safeHighOddsPicks || statsQuery.data.safeHighOddsPicks.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <TrendingUp className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium">No Safe High-Odds picks available for {date}</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                    Safe High-Odds picks combine higher odds (1.50–2.50) with all safety
                    precautions: multi-source consensus (≥2), strong edge (≥4%), positive
                    Kelly stake, and safe markets only (1X2, O/U 2.5/3.5, BTTS, Asian
                    Handicap, Double Chance, Draw No Bet).
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    If none qualify today, the engine couldn&apos;t find higher-odds picks
                    that pass every safety check — try the Safe Picks tab for lower-odds
                    near-guaranteed returns instead.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-cyan-500" />
                    Safe High-Odds Picks
                  </h3>
                  <Badge variant="secondary" className="text-xs border-cyan-400 text-cyan-700 dark:text-cyan-300">
                    {statsQuery.data.stats.safeHighOddsCount} total
                  </Badge>
                </div>
                <div className="space-y-1.5">
                  {statsQuery.data.safeHighOddsPicks.map((v) => (
                    <PredictionRow
                      key={v.id}
                      p={{
                        id: v.id,
                        market: v.market,
                        selection: v.selection,
                        confidence: v.confidence,
                        probability: v.probability ?? 0,
                        fairOdds: v.bookOdds ?? 0,
                        bookOdds: v.bookOdds,
                        edge: v.edge,
                        isTopPick: false,
                        isValueBet: true,
                        isSafePick: v.isSafePick,
                        isSafeHighOdds: true,
                        consensusSources: v.consensusSources,
                        sourcesJson: null,
                        recommendedStake: v.recommendedStake,
                        clv: v.clv,
                      }}
                    />
                  ))}
                  <p className="text-xs text-muted-foreground italic text-center pt-2">
                    Showing top {statsQuery.data.safeHighOddsPicks.length} investment-grade
                    picks with odds in 1.50–2.50 band for {date}. Each pick clears
                    multi-source consensus, strong edge, positive Kelly, and safe-market
                    checks — meaningful upside with all safety precautions intact.
                  </p>
                </div>
              </>
            )}
          </TabsContent>

          {/* Safe picks tab — the safest pick from each predicted match */}
          <TabsContent value="safe" className="space-y-3 mt-4">
            {statsQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-md" />
                ))}
              </div>
            ) : statsQuery.isError || !statsQuery.data || !statsQuery.data.safePicks || statsQuery.data.safePicks.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Shield className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium">No matches predicted for {date}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Run the pipeline to generate predictions, or pick a different date.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Shield className="h-4 w-4 text-emerald-500" />
                    Safe Pick Per Match
                  </h3>
                  <Badge variant="secondary" className="text-xs">
                    {statsQuery.data.stats.safePicksCount} {statsQuery.data.stats.safePicksCount === 1 ? "match" : "matches"}
                  </Badge>
                </div>
                <div className="space-y-2">
                  {statsQuery.data.safePicks.map((v) => {
                    const isTrueSafe = v.isSafePick === true;
                    return (
                      <div key={v.id} className="rounded-md border border-border/60 bg-card/50 px-3 py-2">
                        <div className="flex items-center justify-between gap-2 mb-1.5 text-[11px] text-muted-foreground">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Clock className="h-3 w-3 shrink-0" />
                            <span className="font-mono font-medium">{v.kickoffBrussels ?? "—"}</span>
                            <span>·</span>
                            <span className="truncate">{v.league ?? "—"}</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {v.isTopPick && (
                              <Badge variant="outline" className="text-[9px] h-4 px-1 border-violet-400 text-violet-600 dark:text-violet-300 font-semibold">
                                TOP
                              </Badge>
                            )}
                            <Badge
                              variant="outline"
                              className={
                                "text-[9px] h-4 px-1 font-semibold " +
                                (isTrueSafe
                                  ? "border-emerald-400 text-emerald-600 dark:text-emerald-300"
                                  : "border-amber-400 text-amber-600 dark:text-amber-300")
                              }
                            >
                              {isTrueSafe ? "SAFE" : "BEST"}
                            </Badge>
                          </div>
                        </div>
                        <div className="font-semibold text-xs mb-1.5 truncate">{v.match}</div>
                        <PredictionRow
                          p={{
                            id: v.id,
                            market: v.market,
                            selection: v.selection,
                            confidence: v.confidence,
                            probability: v.probability ?? 0,
                            fairOdds: v.bookOdds ?? 0,
                            bookOdds: v.bookOdds,
                            edge: v.edge,
                            isTopPick: v.isTopPick === true,
                            isValueBet: false,
                            isSafePick: isTrueSafe,
                            consensusSources: v.consensusSources,
                            sourcesJson: null,
                            recommendedStake: v.recommendedStake,
                            clv: v.clv,
                          }}
                          compact
                        />
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground italic text-center pt-2">
                    Showing the safest pick from each of the top {statsQuery.data.safePicks.length} predicted matches for {date}.
                    {" "}
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">SAFE</span> = clears the safe-pick threshold;
                    {" "}
                    <span className="text-amber-600 dark:text-amber-400 font-medium">BEST</span> = best available (no pick cleared the strict threshold, so the highest-probability option is shown).
                  </p>
                </div>
              </>
            )}
          </TabsContent>

          {/* Value bets tab — one best value bet per predicted match */}
          <TabsContent value="value" className="space-y-3 mt-4">
            {statsQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-md" />
                ))}
              </div>
            ) : statsQuery.isError || !statsQuery.data || !statsQuery.data.valueBets || statsQuery.data.valueBets.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Target className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium">No matches predicted for {date}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Run the pipeline to generate predictions, or pick a different date.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-emerald-500" />
                    Best Value Bet Per Match
                  </h3>
                  <Badge variant="secondary" className="text-xs">
                    {statsQuery.data.stats.valueBetsCount} {statsQuery.data.stats.valueBetsCount === 1 ? "match" : "matches"}
                  </Badge>
                </div>
                <div className="space-y-2">
                  {statsQuery.data.valueBets.map((v) => {
                    const isTrueValue = v.isValueBet === true;
                    return (
                      <div key={v.id} className="rounded-md border border-border/60 bg-card/50 px-3 py-2">
                        <div className="flex items-center justify-between gap-2 mb-1.5 text-[11px] text-muted-foreground">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Clock className="h-3 w-3 shrink-0" />
                            <span className="font-mono font-medium">{v.kickoffBrussels ?? "—"}</span>
                            <span>·</span>
                            <span className="truncate">{v.league ?? "—"}</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {v.isTopPick && (
                              <Badge variant="outline" className="text-[9px] h-4 px-1 border-violet-400 text-violet-600 dark:text-violet-300 font-semibold">
                                TOP
                              </Badge>
                            )}
                            <Badge
                              variant="outline"
                              className={
                                "text-[9px] h-4 px-1 font-semibold " +
                                (isTrueValue
                                  ? "border-emerald-400 text-emerald-600 dark:text-emerald-300"
                                  : "border-amber-400 text-amber-600 dark:text-amber-300")
                              }
                            >
                              {isTrueValue ? "VALUE" : "BEST"}
                            </Badge>
                          </div>
                        </div>
                        <div className="font-semibold text-xs mb-1.5 truncate">{v.match}</div>
                        <PredictionRow
                          p={{
                            id: v.id,
                            market: v.market,
                            selection: v.selection,
                            confidence: v.confidence,
                            probability: v.probability ?? 0,
                            fairOdds: v.bookOdds ?? 0,
                            bookOdds: v.bookOdds,
                            edge: v.edge,
                            isTopPick: v.isTopPick === true,
                            isValueBet: isTrueValue,
                            isSafePick: v.isSafePick,
                            isSafeHighOdds: v.isSafeHighOdds,
                            consensusSources: v.consensusSources,
                            sourcesJson: null,
                            recommendedStake: v.recommendedStake,
                            clv: v.clv,
                          }}
                          compact
                        />
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground italic text-center pt-2">
                    Showing the best value bet from each of the top {statsQuery.data.valueBets.length} predicted matches for {date}.
                    {" "}
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">VALUE</span> = clears the value-bet threshold (edge ≥ 2.5%, prob 40–82%);
                    {" "}
                    <span className="text-amber-600 dark:text-amber-400 font-medium">BEST</span> = best available (highest-edge pick when no market cleared the strict threshold).
                  </p>
                </div>
              </>
            )}
          </TabsContent>

          {/* Performance tab */}
          <TabsContent value="performance" className="mt-4">
            {performanceQuery.isLoading ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-lg" />
                ))}
              </div>
            ) : performanceQuery.isError || !performanceQuery.data ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  Failed to load performance data.
                </CardContent>
              </Card>
            ) : (
              <PerformanceDashboard
                snapshots={performanceQuery.data.snapshots}
                sources={performanceQuery.data.sources}
                aggregates={performanceQuery.data.aggregates}
                marketAgg={performanceQuery.data.marketAgg}
              />
            )}
          </TabsContent>
        </Tabs>

        {/* Latest scrape logs (small footer) */}
        {statsQuery.data && statsQuery.data.recentScrapeLogs.length > 0 && (
          <Card className="mt-4">
            <CardContent className="p-3 sm:p-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent Scrape Runs
                </h4>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {statsQuery.data.recentScrapeLogs.slice(0, 6).map((log) => (
                  <Badge
                    key={log.id}
                    variant={log.status === "success" ? "default" : log.status === "failed" ? "destructive" : "secondary"}
                    className="text-[10px] gap-1"
                  >
                    {log.source}: {log.status} · {log.matchesFound} matches
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t py-3 px-4 text-center text-[10px] text-muted-foreground">
        <p>
          BetIQ · AI Football Predictions · Self-learning source-weighted model ·{" "}
          <span className="font-mono">Europe/Brussels timezone</span> ·{" "}
          Predictions are probabilities, not guarantees. 18+ · Gamble responsibly.
        </p>
      </footer>

      {/* Match detail dialog */}
      <MatchDetailDialog
        match={matchDetail}
        open={matchDetailOpen}
        onOpenChange={(o) => {
          setMatchDetailOpen(o);
          if (!o) {
            setTimeout(() => {
              setMatchDetail(null);
              setSelectedMatchId(null);
            }, 200);
          }
        }}
      />

      <Toaster />
    </div>
  );
}
