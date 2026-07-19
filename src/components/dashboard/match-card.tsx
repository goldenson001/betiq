"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Clock, ChevronDown } from "lucide-react";
import { PredictionRow, type PredictionView } from "./prediction-row";
import { cn } from "@/lib/utils";

export interface MatchView {
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
  predictions: PredictionView[];
}

interface MatchCardProps {
  match: MatchView;
  onOpen: (match: MatchView) => void;
}

const MARKET_ORDER = [
  "1x2",
  "double_chance",
  "dnb",
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
];

export function MatchCard({ match, onOpen }: MatchCardProps) {
  const top = match.predictions.find((p) => p.isTopPick);
  const sorted = [...match.predictions].sort(
    (a, b) => MARKET_ORDER.indexOf(a.market) - MARKET_ORDER.indexOf(b.market) || b.confidence - a.confidence
  );
  const hasResult = match.status === "finished" && match.homeScore !== null && match.awayScore !== null;
  const isLive = match.status === "live" && match.homeScore !== null && match.awayScore !== null;
  // Defensive: never render a score for scheduled / postponed / cancelled matches.
  // Even if a scraper bug (or stale DB row) leaks homeScore=0/awayScore=0 into
  // a scheduled match, the UI must NOT show it as a real score. Only live and
  // finished matches are allowed to display a score block.
  const hasScore =
    match.homeScore !== null &&
    match.awayScore !== null &&
    (match.status === "live" || match.status === "finished");
  const avgConfidence =
    match.predictions.length > 0
      ? Math.round(match.predictions.reduce((s, p) => s + p.confidence, 0) / match.predictions.length)
      : 0;
  const valueBetsCount = match.predictions.filter((p) => p.isValueBet).length;

  return (
    <Card
      className="overflow-hidden cursor-pointer hover:border-primary/40 hover:shadow-md transition-all"
      onClick={() => onOpen(match)}
    >
      <CardHeader className="pb-2 pt-3 px-4 bg-muted/30">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-mono font-medium text-muted-foreground">
              {match.kickoffBrussels}
            </span>
            <span className="text-xs text-muted-foreground truncate">·</span>
            <span className="text-xs text-muted-foreground truncate">{match.league?.name ?? "—"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {valueBetsCount > 0 && (
              <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-600 dark:text-amber-400 font-semibold">
                {valueBetsCount} VALUE
              </Badge>
            )}
            {hasResult && (
              <Badge variant="secondary" className="text-[10px] font-semibold">
                FT {match.homeScore}-{match.awayScore}
              </Badge>
            )}
            {isLive && (
              <Badge
                variant="outline"
                className="text-[10px] font-semibold border-rose-400 text-rose-600 dark:text-rose-300 gap-1"
                title="Live — auto-refreshing"
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-rose-500"></span>
                </span>
                LIVE {match.homeScore}-{match.awayScore}
              </Badge>
            )}
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 py-3">
        {/* Teams row with form badges */}
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold truncate text-right">{match.homeTeam}</div>
            {match.homeForm && (
              <div className="flex gap-0.5 mt-1 justify-end">
                {match.homeForm.slice(0, 5).split("").map((c, i) => (
                  <span
                    key={i}
                    className={
                      "w-3.5 h-3.5 rounded text-[8px] font-bold flex items-center justify-center " +
                      (c === "W"
                        ? "bg-emerald-500 text-white"
                        : c === "D"
                          ? "bg-amber-500 text-white"
                          : c === "L"
                            ? "bg-rose-500 text-white"
                            : "bg-muted text-muted-foreground")
                    }
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className={
            "text-[10px] uppercase tracking-wider text-muted-foreground px-1.5 py-0.5 rounded font-semibold shrink-0 " +
            (hasScore ? "bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300" : "bg-muted")
          }>
            {hasScore ? `${match.homeScore}-${match.awayScore}` : "v"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold truncate">{match.awayTeam}</div>
            {match.awayForm && (
              <div className="flex gap-0.5 mt-1">
                {match.awayForm.slice(0, 5).split("").map((c, i) => (
                  <span
                    key={i}
                    className={
                      "w-3.5 h-3.5 rounded text-[8px] font-bold flex items-center justify-center " +
                      (c === "W"
                        ? "bg-emerald-500 text-white"
                        : c === "D"
                          ? "bg-amber-500 text-white"
                          : c === "L"
                            ? "bg-rose-500 text-white"
                            : "bg-muted text-muted-foreground")
                    }
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* H2H summary mini-row */}
        {match.h2hJson && (() => {
          try {
            const h2h = JSON.parse(match.h2hJson);
            if (!h2h || !h2h.totalGames) return null;
            return (
              <div className="flex items-center justify-center gap-2 text-[10px] text-muted-foreground mb-2">
                <span className="uppercase tracking-wider">H2H:</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{h2h.homeWins}H</span>
                <span className="text-amber-600 dark:text-amber-400 font-semibold">{h2h.draws}D</span>
                <span className="text-blue-600 dark:text-blue-400 font-semibold">{h2h.awayWins}A</span>
                <span className="text-muted-foreground">·</span>
                <span>{h2h.totalGames} games</span>
              </div>
            );
          } catch { return null; }
        })()}

        {/* Average confidence bar */}
        <div className="flex items-center gap-2 mb-3 text-[10px]">
          <span className="text-muted-foreground uppercase tracking-wider">Avg Conf.</span>
          <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full transition-all",
                avgConfidence >= 75 ? "bg-emerald-500" : avgConfidence >= 60 ? "bg-lime-500" : avgConfidence >= 45 ? "bg-amber-500" : "bg-rose-500"
              )}
              style={{ width: `${avgConfidence}%` }}
            />
          </div>
          <span className="font-bold tabular-nums">{avgConfidence}%</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{match.predictions.length} markets</span>
        </div>

        {/* Top pick — always shown prominently */}
        {top && (
          <div className="mb-2">
            <PredictionRow p={top} />
          </div>
        )}

        {/* ALL other market predictions — show every market, no truncation */}
        <div className="space-y-1">
          {sorted
            .filter((p) => !p.isTopPick)
            .map((p) => (
              <PredictionRow key={p.id} p={p} compact />
            ))}
        </div>

        {/* Footer hint */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(match);
          }}
          className="mt-2 w-full text-[11px] text-primary hover:text-primary/80 font-medium flex items-center justify-center gap-1 py-1 border-t border-border/50 pt-2"
        >
          <ChevronDown className="h-3 w-3" />
          View source breakdown & expert consensus
        </button>
      </CardContent>
    </Card>
  );
}
