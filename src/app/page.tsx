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
  AlertTriangle,
  Activity,
  Radio,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import { MatchCard, type MatchView } from "@/components/dashboard/match-card";
import { MatchDetailDialog, type MatchDetailView } from "@/components/dashboard/match-detail";
import { ParlayCard, type ParlayView, parlayTypeOrder } from "@/components/dashboard/parlay-card";
import { BankrollSimulator } from "@/components/dashboard/bankroll-simulator";
import { PickCard } from "@/components/dashboard/pick-card";
import { PickListSkeleton, PickTabEmpty } from "@/components/dashboard/pick-list-skeleton";
import { WonParlaysHistory } from "@/components/dashboard/won-parlays-history";
import {
  PerformanceDashboard,
  type SnapshotView,
  type SourceView,
  type AggregatesView,
  type MarketAggView,
} from "@/components/dashboard/performance";

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

// ── Live scores auto-refresh ────────────────────────────────────────────────
// Polled every 30s from /api/scores/live. Updates match scores in DB and
// returns per-parlay per-leg live status. The UI merges this into the matches
// and parlays queries via cache invalidation + direct state merge.
interface ScoresLiveResponse {
  ok: boolean;
  date: string;
  lastUpdated: string;
  counts: {
    total: number;
    live: number;
    finished: number;
    scheduled: number;
    postponed: number;
    cancelled: number;
  };
  matches: Array<{
    id: string;
    externalId: string;
    homeTeam: string;
    awayTeam: string;
    kickoffBrussels: string | null;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    htHomeScore: number | null;
    htAwayScore: number | null;
    leagueId: string | null;
    leagueName: string | null;
    leagueCountry: string | null;
  }>;
  parlays: Array<{
    id: string;
    type: string;
    legsCount: number;
    legsWon: number;
    legsLost: number;
    legsPending: number;
    busted: boolean;
    won: boolean;
    hasLiveLeg: boolean;
    legs: Array<{
      predictionId: string;
      matchId: string;
      matchLabel: string;
      market: string;
      selection: string;
      decided: boolean;
      won: boolean;
      pending: boolean;
      matchStatus: string;
      homeScore: number | null;
      awayScore: number | null;
    }>;
  }>;
  espnPolled: boolean;
  error?: string;
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
  // C1: Risk gate info from the engine (B1 + B2)
  riskGate?: {
    drawdownState: "normal" | "degraded" | "halted";
    drawdownReason: string | null;
    todayExposure: number;
    maxExposure: number;
    portfolioScale: number;
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
    consensusSources?: number;
    disagreement?: number | null;
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

  // ── Live auto-refresh state ─────────────────────────────────────────────
  // Default ON — users land on the dashboard with live scores already
  // streaming. They can toggle it off in the header.
  const [liveRefreshEnabled, setLiveRefreshEnabled] = useState(true);
  const [liveData, setLiveData] = useState<ScoresLiveResponse | null>(null);

  // ── Info banner dismiss state ───────────────────────────────────────────
  // The "Live ESPN data" banner is informational and only needs to be seen
  // once per session. After the user dismisses it (or after 12 seconds
  // auto-dismiss), it stays hidden until the next session. Stored in
  // sessionStorage so a fresh tab always shows it at least once.
  const [infoBannerDismissed, setInfoBannerDismissed] = useState(false);
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.sessionStorage.getItem("betiq_info_banner_dismissed") === "1") {
        setInfoBannerDismissed(true);
      }
    } catch {
      // sessionStorage may throw in some privacy modes — fail silently.
    }
    // Auto-dismiss after 12 seconds the first time the user sees it.
    if (!infoBannerDismissed) {
      const t = setTimeout(() => dismissInfoBanner(), 12_000);
      return () => clearTimeout(t);
    }
  }, []);

  function dismissInfoBanner() {
    setInfoBannerDismissed(true);
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem("betiq_info_banner_dismissed", "1");
      }
    } catch {
      // ignore
    }
  }

  // ── Owner mode (no login, no lock button) ───────────────────────────────
  // The user wants the "Won Parlays History" view to behave like the
  // Performance tab — auto-visible to them (the site owner) without any
  // password modal or unlock button.
  //
  // Pattern:
  //   - Owner visits /api/owner/unlock?token=SITE_OWNER_TOKEN ONCE per browser.
  //     Server sets a 10-year HTTP-only signed cookie (`betiq_owner`).
  //   - On every page load we probe /api/owner/session to check the cookie.
  //     If present, isOwner=true → the "Won History" tab is rendered.
  //   - Non-owner visitors never see the tab, never fire the gated fetch.
  //   - No lock button in the header. To log out, the owner visits
  //     /api/owner/lock on purpose.
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/owner/session");
        const data = (await r.json().catch(() => ({}))) as {
          isOwner?: boolean;
        };
        if (!cancelled && typeof data.isOwner === "boolean") {
          setIsOwner(data.isOwner);
        }
      } catch {
        // Network error — fail closed (non-owner).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [livePolling, setLivePolling] = useState(false);
  const [lastLiveUpdate, setLastLiveUpdate] = useState<Date | null>(null);

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

  // ── Source health (D2) — tracks which scrapers are actually working ───────
  interface SourceHealth {
    name: string;
    displayName: string;
    url: string;
    weight: number;
    lastScrapedAt: string | null;
    lastStatus: "success" | "failed" | "never";
    lastError: string | null;
    lastMatchesFound: number;
    recentSuccessRate: number;
    recentSamples: number;
    isActive: boolean;
    isHealthy: boolean;
  }
  interface SourcesStatusResponse {
    ok: boolean;
    totalSources: number;
    activeSources: number;
    healthySources: number;
    sources: SourceHealth[];
  }
  const sourcesQuery = useQuery<SourcesStatusResponse>({
    queryKey: ["sources-status"],
    queryFn: async () => {
      const r = await fetch(`/api/sources/status`);
      if (!r.ok) throw new Error("Failed to load sources status");
      return r.json() as Promise<SourcesStatusResponse>;
    },
    staleTime: 2 * 60_000,
  });

  // ── Live scores polling ────────────────────────────────────────────────
  // Polls /api/scores/live every 30s when enabled. The endpoint fetches ESPN
  // scoreboards for the current date, updates match scores/status in DB, and
  // returns per-parlay per-leg live status. We then invalidate the matches/
  // parlays/stats React Query caches so the UI re-renders with fresh scores.
  const pollLiveScores = useCallback(async () => {
    setLivePolling(true);
    try {
      const r = await fetch(`/api/scores/live?date=${date}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as ScoresLiveResponse;
      setLiveData(data);
      setLastLiveUpdate(new Date());
      // Invalidate caches so matches/parlays/stats re-fetch with the new
      // scores the server just persisted.
      queryClient.invalidateQueries({ queryKey: ["matches", date] });
      queryClient.invalidateQueries({ queryKey: ["parlays", date] });
      queryClient.invalidateQueries({ queryKey: ["stats", date] });
    } catch (err) {
      // Silent fail — don't toast on every polling error (too noisy). Just
      // log to console so devs can see what happened.
      console.warn("[live-scores] poll failed:", (err as Error).message);
    } finally {
      setLivePolling(false);
    }
  }, [date, queryClient]);

  // Set up the 30s interval. Also re-poll immediately when `date` changes so
  // the user doesn't have to wait 30s to see live scores on the new date.
  useEffect(() => {
    if (!liveRefreshEnabled) return;
    // Initial poll right away (also covers date change)
    pollLiveScores();
    const id = setInterval(pollLiveScores, 30_000);
    return () => clearInterval(id);
  }, [liveRefreshEnabled, date, pollLiveScores]);

  // ── One-shot live-scores poll on initial mount ──────────────────────────
  // Even when the user has auto-refresh OFF, we still want to:
  //   1. Pull fresh scores once on page load (so finished matches show their
  //      real scores instead of "TBP")
  //   2. Auto-settle any parlays whose legs are all decided (the
  //      /api/scores/live endpoint now persists parlay evaluation when all
  //      legs are finished — this is the safety net for when the daily
  //      feedback cron doesn't run on serverless)
  // Subsequent polls only happen if the user turns auto-refresh back ON.
  useEffect(() => {
    pollLiveScores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            {/* Live Auto-Refresh toggle — when ON, polls /api/scores/live every 30s */}
            <Button
              variant={liveRefreshEnabled ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setLiveRefreshEnabled((v) => !v);
                if (liveRefreshEnabled) {
                  toast.info("Live auto-refresh paused");
                } else {
                  toast.success("Live auto-refresh resumed — scores will update every 30s");
                }
              }}
              className={
                "gap-1.5 text-xs " +
                (liveRefreshEnabled
                  ? "bg-rose-600 hover:bg-rose-700 text-white border-rose-600"
                  : "")
              }
              title={
                liveRefreshEnabled
                  ? `Live auto-refresh ON — polls ESPN every 30s. Last update: ${
                      lastLiveUpdate ? lastLiveUpdate.toLocaleTimeString() : "never"
                    }`
                  : "Live auto-refresh OFF — click to resume"
              }
            >
              {livePolling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Radio className={"h-3.5 w-3.5 " + (liveRefreshEnabled ? "animate-pulse" : "")} />
              )}
              <span className="hidden md:inline">
                {liveRefreshEnabled ? "Live" : "Paused"}
              </span>
              {liveRefreshEnabled && liveData && liveData.counts.live > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-1 h-4 px-1 text-[9px] font-bold bg-white/20 text-white border-white/30"
                >
                  {liveData.counts.live}
                </Badge>
              )}
            </Button>
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
        {/* Live data banner — dismissible (auto-dismiss after 12s or click X).
            Persists dismissal in sessionStorage so it stays gone for the session. */}
        {!infoBannerDismissed && (
          <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-xs flex items-start gap-2 animate-in fade-in slide-in-from-top-2 duration-300">
            <Info className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
            <div className="text-emerald-900 dark:text-emerald-200 flex-1">
              <strong className="font-semibold">Live ESPN data.</strong> Today's fixtures, team form, head-to-head records,
              and DraftKings odds are pulled in real time from the ESPN Soccer API. PredictZ, WinDrawWin, and StatArea
              consensus predictions are layered on top when reachable. The confidence engine, parlay builder, value-bet
              finder, and self-learning feedback loop all run end-to-end on the resulting data.
            </div>
            <button
              type="button"
              onClick={dismissInfoBanner}
              aria-label="Dismiss info banner"
              className="shrink-0 ml-1 p-1 rounded-md text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 transition-colors"
              title="Dismiss (auto-hides in 12s)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Live scores status banner — shows when auto-refresh is ON */}
        {liveRefreshEnabled && liveData && (
          <div className={
            "rounded-lg border px-3 py-2 text-xs flex items-center justify-between gap-3 flex-wrap " +
            (liveData.counts.live > 0
              ? "border-rose-400/60 bg-rose-500/10"
              : "border-slate-300/40 bg-slate-100/40 dark:bg-slate-900/30")
          }>
            <div className="flex items-center gap-2">
              {liveData.counts.live > 0 ? (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                </span>
              ) : (
                <Radio className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              )}
              <div className={
                liveData.counts.live > 0
                  ? "text-rose-900 dark:text-rose-200"
                  : "text-muted-foreground"
              }>
                {liveData.counts.live > 0 ? (
                  <>
                    <strong className="font-semibold">{liveData.counts.live} match{liveData.counts.live === 1 ? "" : "es"} live</strong>
                    {" · "}
                    {liveData.counts.finished} finished · {liveData.counts.scheduled} scheduled
                  </>
                ) : (
                  <>
                    <strong className="font-semibold">Auto-refresh active.</strong>{" "}
                    No matches currently in play. Scores will refresh every 30s once kick-off begins.
                    {" · "}
                    {liveData.counts.finished} finished · {liveData.counts.scheduled} scheduled today
                  </>
                )}
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-1.5 font-mono">
              <Clock className="h-3 w-3" />
              {lastLiveUpdate ? `Updated ${lastLiveUpdate.toLocaleTimeString()}` : "Pending…"}
              {livePolling && <Loader2 className="h-3 w-3 animate-spin" />}
            </div>
          </div>
        )}

        {/* C3: Drawdown / risk-gate banner — appears when drawdownState != normal */}
        {statsQuery.data?.riskGate && statsQuery.data.riskGate.drawdownState !== "normal" && (
          <div className={
            "rounded-lg border px-3 py-2 text-xs flex items-start gap-2 " +
            (statsQuery.data.riskGate.drawdownState === "halted"
              ? "border-rose-500 bg-rose-500/10"
              : "border-amber-500 bg-amber-500/10")
          }>
            <AlertTriangle className={
              "h-3.5 w-3.5 mt-0.5 shrink-0 " +
              (statsQuery.data.riskGate.drawdownState === "halted"
                ? "text-rose-600 dark:text-rose-400"
                : "text-amber-600 dark:text-amber-400")
            } />
            <div className={
              statsQuery.data.riskGate.drawdownState === "halted"
                ? "text-rose-900 dark:text-rose-200"
                : "text-amber-900 dark:text-amber-200"
            }>
              <strong className="font-semibold">
                {statsQuery.data.riskGate.drawdownState === "halted" ? "Model halted." : "Model in degraded mode."}
              </strong>{" "}
              {statsQuery.data.riskGate.drawdownReason ?? "Stakes reduced for capital preservation."}
              {statsQuery.data.riskGate.drawdownState === "degraded" && (
                <> Recommended stakes are running at 50% of their normal size. </>
              )}
              {statsQuery.data.riskGate.drawdownState === "halted" && (
                <> All recommended stakes are zeroed until the model recovers. </>
              )}
            </div>
          </div>
        )}

        {/* C1: Portfolio daily exposure banner — appears when portfolio cap is engaged */}
        {statsQuery.data?.riskGate && statsQuery.data.riskGate.portfolioScale < 1.0 && (
          <div className="rounded-lg border border-blue-400/40 bg-blue-400/10 px-3 py-2 text-xs flex items-start gap-2">
            <Shield className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
            <div className="text-blue-900 dark:text-blue-200">
              <strong className="font-semibold">Portfolio cap engaged.</strong>{" "}
              Today&apos;s total exposure ({(statsQuery.data.riskGate.todayExposure * 100).toFixed(1)}%)
              exceeds the {(statsQuery.data.riskGate.maxExposure * 100).toFixed(0)}% daily cap.
              All stakes scaled to {(statsQuery.data.riskGate.portfolioScale * 100).toFixed(0)}% of their normal size for
              capital preservation.
            </div>
          </div>
        )}

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
            {/* C3: Tomorrow + weekend quick-nav chips */}
            <div className="flex items-center gap-1">
              {(() => {
                const today = parseISO(brusselsToday());
                const tomorrow = format(addDays(today, 1), "yyyy-MM-dd");
                // Find next Saturday and Sunday from today
                let saturday = today;
                let sunday = today;
                while (saturday.getDay() !== 6) saturday = addDays(saturday, 1);
                while (sunday.getDay() !== 0) sunday = addDays(sunday, 1);
                const satStr = format(saturday, "yyyy-MM-dd");
                const sunStr = format(sunday, "yyyy-MM-dd");
                const monday = format(addDays(sunday, 1), "yyyy-MM-dd");
                const chips = [
                  { label: "Tomorrow", date: tomorrow, today: false },
                  { label: "Sat", date: satStr, today: satStr === brusselsToday() },
                  { label: "Sun", date: sunStr, today: sunStr === brusselsToday() },
                  { label: "Mon", date: monday, today: false },
                ];
                return chips.map((c) => (
                  <Button
                    key={c.label}
                    variant={date === c.date ? "default" : "ghost"}
                    size="sm"
                    className="text-xs h-8 px-2"
                    onClick={() => setDate(c.date)}
                  >
                    {c.label}
                  </Button>
                ));
              })()}
            </div>
            {/* C3: Data freshness pill — green if any source scraped < 6h ago */}
            {statsQuery.data?.sources && statsQuery.data.sources.length > 0 && (() => {
              const sources = statsQuery.data.sources;
              const lastScraped = sources
                .map((s) => s.lastScrapedAt ? new Date(s.lastScrapedAt).getTime() : 0)
                .reduce((max, t) => Math.max(max, t), 0);
              const ageHours = lastScraped > 0 ? (Date.now() - lastScraped) / (1000 * 60 * 60) : Infinity;
              const fresh = ageHours < 6;
              const stale = ageHours > 24;
              return (
                <Badge
                  variant="outline"
                  className={
                    "text-xs gap-1 " +
                    (fresh
                      ? "border-emerald-400 text-emerald-700 dark:text-emerald-300"
                      : stale
                        ? "border-rose-400 text-rose-700 dark:text-rose-300"
                        : "border-amber-400 text-amber-700 dark:text-amber-300")
                  }
                  title={`Last scrape: ${lastScraped > 0 ? new Date(lastScraped).toLocaleString() : "never"}`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {fresh ? "Fresh" : stale ? "Stale" : "Aging"}
                </Badge>
              );
            })()}
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
              {/* D2: Source health badge — shows how many scrapers are actually returning data */}
              {sourcesQuery.data && (
                <Badge
                  variant="secondary"
                  className={
                    "gap-1 text-xs " +
                    (sourcesQuery.data.activeSources >= sourcesQuery.data.totalSources * 0.6
                      ? "border-emerald-400 text-emerald-700 dark:text-emerald-300"
                      : sourcesQuery.data.activeSources >= sourcesQuery.data.totalSources * 0.3
                        ? "border-amber-400 text-amber-700 dark:text-amber-300"
                        : "border-rose-400 text-rose-700 dark:text-rose-300")
                  }
                  title={
                    sourcesQuery.data.sources
                      .filter((s) => !s.isActive)
                      .map((s) => `${s.displayName}: ${s.lastError ?? "no recent data"}`)
                      .join("\n") || "All sources active"
                  }
                >
                  <Activity className="h-3 w-3" />
                  {sourcesQuery.data.activeSources}/{sourcesQuery.data.totalSources} sources
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
              {/* Owner-only tab — only rendered when the visitor has the
                  betiq_owner cookie (set via /api/owner/unlock?token=...).
                  Non-owner visitors never see this tab and the underlying
                  WonParlaysHistory component silently 404s for them, so the
                  historical won-parlay data stays private. Behaves exactly
                  like the Performance tab being visible only to the owner. */}
              {isOwner && (
                <TabsTrigger
                  value="won-history"
                  className="gap-1.5 text-xs sm:text-sm data-[state=active]:bg-violet-600 data-[state=active]:text-white"
                >
                  <Trophy className="h-3.5 w-3.5" /> Won History
                </TabsTrigger>
              )}
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
                  .map((p) => {
                    // Merge live parlay status (leg-by-leg W/L/pending + bust flag)
                    // from /api/scores/live into the parlay view. Falls back to
                    // undefined if live data isn't available yet.
                    const liveP = liveData?.parlays.find((lp) => lp.id === p.id);
                    const merged: ParlayView = liveP
                      ? {
                          ...p,
                          live: {
                            legsWon: liveP.legsWon,
                            legsLost: liveP.legsLost,
                            legsPending: liveP.legsPending,
                            busted: liveP.busted,
                            won: liveP.won,
                            hasLiveLeg: liveP.hasLiveLeg,
                            legs: Object.fromEntries(
                              liveP.legs.map((l) => [
                                l.predictionId,
                                {
                                  decided: l.decided,
                                  won: l.won,
                                  pending: l.pending,
                                  matchStatus: l.matchStatus,
                                  homeScore: l.homeScore,
                                  awayScore: l.awayScore,
                                },
                              ])
                            ),
                          },
                        }
                      : p;
                    return <ParlayCard key={p.id} parlay={merged} />;
                  })}
              </div>
            )}
          </TabsContent>

          {/* Safe High-Odds tab — investment-grade picks with odds 1.50-2.50 */}
          <TabsContent value="safe-high-odds" className="space-y-3 mt-4">
            {statsQuery.isLoading ? (
              <PickListSkeleton rows={5} />
            ) : statsQuery.isError || !statsQuery.data || !statsQuery.data.safeHighOddsPicks || statsQuery.data.safeHighOddsPicks.length === 0 ? (
              <PickTabEmpty
                icon={<TrendingUp className="h-10 w-10" />}
                title={`No Safe High-Odds picks available for ${date}`}
                body="Safe High-Odds picks combine higher odds (1.50–2.50) with all safety precautions: at least 1 source consensus, positive edge (≥2%), positive recommended stake, and safe markets only (1X2, O/U 2.5/3.5, BTTS, Asian Handicap, Double Chance, Draw No Bet)."
                hint="If none qualify today, the engine couldn't find higher-odds picks that pass every safety check — try the Safe Picks tab for lower-odds near-guaranteed returns instead."
              />
            ) : (
              <div className="space-y-2">
                {statsQuery.data.safeHighOddsPicks.map((v) => (
                  <PickCard
                    key={v.id}
                    match={v.match}
                    kickoffBrussels={v.kickoffBrussels}
                    league={v.league}
                    cardClassName="border-cyan-500/30 bg-cyan-500/5"
                    prediction={{
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
                      disagreement: v.disagreement,
                      sourcesJson: null,
                      recommendedStake: v.recommendedStake,
                      clv: v.clv,
                    }}
                  />
                ))}
                <p className="text-xs text-muted-foreground italic text-center pt-2">
                  Showing top {statsQuery.data.safeHighOddsPicks.length} investment-grade
                  picks with odds in 1.50–2.50 band for {date}. Each pick clears
                  at least 1 source consensus, positive edge, a positive recommended stake,
                  and safe-market checks — meaningful upside with all safety precautions intact.
                </p>
              </div>
            )}
          </TabsContent>

          {/* Safe picks tab — the safest pick from each predicted match */}
          <TabsContent value="safe" className="space-y-3 mt-4">
            {statsQuery.isLoading ? (
              <PickListSkeleton rows={5} />
            ) : statsQuery.isError || !statsQuery.data || !statsQuery.data.safePicks || statsQuery.data.safePicks.length === 0 ? (
              <PickTabEmpty
                icon={<Shield className="h-10 w-10" />}
                title={`No safe picks predicted for ${date}`}
                body="Run the pipeline to generate predictions, or pick a different date."
              />
            ) : (
              <div className="space-y-2">
                {statsQuery.data.safePicks.map((v) => {
                  const isTrueSafe = v.isSafePick === true;
                  return (
                    <PickCard
                      key={v.id}
                      match={v.match}
                      kickoffBrussels={v.kickoffBrussels}
                      league={v.league}
                      isTopPick={v.isTopPick === true}
                      cardClassName="border-border/60 bg-card/50"
                      statusBadge={
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
                      }
                      prediction={{
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
                    />
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
            )}
          </TabsContent>

          {/* Value bets tab — one best value bet per predicted match */}
          <TabsContent value="value" className="space-y-3 mt-4">
            {statsQuery.isLoading ? (
              <PickListSkeleton rows={5} />
            ) : statsQuery.isError || !statsQuery.data || !statsQuery.data.valueBets || statsQuery.data.valueBets.length === 0 ? (
              <PickTabEmpty
                icon={<Target className="h-10 w-10" />}
                title={`No value bets predicted for ${date}`}
                body="Run the pipeline to generate predictions, or pick a different date."
              />
            ) : (
              <div className="space-y-2">
                {statsQuery.data.valueBets.map((v) => {
                  const isTrueValue = v.isValueBet === true;
                  return (
                    <PickCard
                      key={v.id}
                      match={v.match}
                      kickoffBrussels={v.kickoffBrussels}
                      league={v.league}
                      isTopPick={v.isTopPick === true}
                      cardClassName="border-border/60 bg-card/50"
                      statusBadge={
                        <Badge
                          variant="outline"
                          className={
                            "text-[9px] h-4 px-1 font-semibold " +
                            (isTrueValue
                              ? "border-amber-400 text-amber-600 dark:text-amber-300"
                              : "border-amber-400 text-amber-600 dark:text-amber-300")
                          }
                        >
                          {isTrueValue ? "VALUE" : "BEST"}
                        </Badge>
                      }
                      prediction={{
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
                    />
                  );
                })}
                <p className="text-xs text-muted-foreground italic text-center pt-2">
                  Showing the best value bet from each of the top {statsQuery.data.valueBets.length} predicted matches for {date}.
                  {" "}
                  <span className="text-amber-600 dark:text-amber-400 font-medium">VALUE</span> = clears the value-bet threshold (edge ≥ 2.5%, prob 40–82%);
                  {" "}
                  <span className="text-amber-600 dark:text-amber-400 font-medium">BEST</span> = best available (highest-edge pick when no market cleared the strict threshold).
                </p>
              </div>
            )}
          </TabsContent>

          {/* Performance tab */}
          <TabsContent value="performance" className="mt-4 space-y-4">
            {/* C1: Bankroll Simulator — always visible at the top of Performance tab */}
            <BankrollSimulator
              snapshots={performanceQuery.data?.snapshots ?? []}
              todayExposure={statsQuery.data?.riskGate?.todayExposure}
              drawdownState={statsQuery.data?.riskGate?.drawdownState}
              drawdownReason={statsQuery.data?.riskGate?.drawdownReason ?? undefined}
            />
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

          {/* ── Owner-only: Won Parlay History ─────────────────────────────────
              Tab is only rendered when the visitor has the betiq_owner cookie
              (see the conditional TabsTrigger above). The WonParlaysHistory
              component auto-fetches — same pattern as PerformanceDashboard.
              Non-owner visitors never see this tab; if someone navigates to
              the value via URL state, WonParlaysHistory will silently 404 and
              render a "not available" placeholder. */}
          <TabsContent value="won-history" className="mt-4 space-y-4">
            <Card className="border-violet-400/30 bg-violet-500/5">
              <CardContent className="p-3 sm:p-4 flex items-start gap-2">
                <Shield className="h-4 w-4 text-violet-600 dark:text-violet-300 mt-0.5 shrink-0" />
                <div className="text-xs text-violet-900 dark:text-violet-100">
                  <strong className="font-semibold">Owner-private view.</strong>{" "}
                  Every settled-and-won parlay in the system history, with full
                  leg details, ML signals, and settlement outcome. Each row is
                  dated, settled, and sorted newest-first so you can evaluate
                  which tiers and patterns win most often.
                </div>
              </CardContent>
            </Card>
            <WonParlaysHistory />
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
