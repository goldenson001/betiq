"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PredictionRow, type PredictionView } from "./prediction-row";
import { marketLabel } from "@/lib/dashboard/format";

export interface MatchDetailView {
  id: string;
  externalId: string;
  matchDate: string;
  kickoffBrussels: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  htHomeScore: number | null;
  htAwayScore: number | null;
  corners: number | null;
  cards: number | null;
  homeForm: string | null;
  awayForm: string | null;
  h2hJson: string | null;
  openingOddsJson: string | null;
  closingOddsJson: string | null;
  league: { id: string; name: string; country: string } | null;
  predictions: PredictionView[];
  rawPredictions: Array<{
    id: string;
    source: { name: string; displayName: string; weight: number; accuracy: number };
    predicted1X2: string | null;
    predictedScore: string | null;
    predictedBTTS: string | null;
    predictedOU25: string | null;
  }>;
}

interface Props {
  match: MatchDetailView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MARKET_ORDER = [
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
];

interface H2HMatch {
  date: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  result: "home" | "away" | "draw";
}

interface H2HSummary {
  totalGames: number;
  homeWins: number;
  awayWins: number;
  draws: number;
  lastMatches: H2HMatch[];
}

function parseH2H(json: string | null): H2HSummary | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as H2HSummary;
  } catch {
    return null;
  }
}

/**
 * Render form string like "WLDLL" as colored badges per match.
 * Each letter gets a colored chip: W=green, D=amber, L=red.
 */
function FormBadges({ form }: { form: string | null }) {
  if (!form) return <span className="text-xs text-muted-foreground italic">N/A</span>;
  const recent = form.slice(0, 5);
  return (
    <div className="flex gap-1">
      {recent.split("").map((c, i) => (
        <span
          key={i}
          className={
            "w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center " +
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
  );
}

export function MatchDetailDialog({ match, open, onOpenChange }: Props) {
  if (!match) return null;
  const sorted = [...match.predictions].sort(
    (a, b) => MARKET_ORDER.indexOf(a.market) - MARKET_ORDER.indexOf(b.market) || b.confidence - a.confidence
  );
  const hasResult = match.status === "finished" && match.homeScore !== null && match.awayScore !== null;
  // Also support live matches in the detail dialog (UX gap — previously only
  // FT matches showed their score; live matches showed nothing). Defensive:
  // never render a score for scheduled / postponed / cancelled matches, even
  // if stale 0/0 values leak into the DB from a scraper bug.
  const isLive = match.status === "live" && match.homeScore !== null && match.awayScore !== null;
  const hasScore = hasResult || isLive;
  const h2h = parseH2H(match.h2hJson);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] p-0 gap-0">
        <DialogHeader className="p-5 pb-3 border-b">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <span className="font-mono">{match.kickoffBrussels}</span>
            <span>·</span>
            <span>{match.league?.name ?? "Unknown league"}</span>
            <span>·</span>
            <span>{match.league?.country}</span>
            {hasResult && (
              <Badge variant="secondary" className="ml-auto text-[10px]">
                FT {match.homeScore}-{match.awayScore}
              </Badge>
            )}
            {isLive && (
              <Badge
                variant="outline"
                className="ml-auto text-[10px] border-rose-400 text-rose-600 dark:text-rose-300 gap-1"
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-rose-500" />
                </span>
                LIVE {match.homeScore}-{match.awayScore}
              </Badge>
            )}
          </div>
          <DialogTitle className="text-lg sm:text-xl flex items-center justify-between gap-3">
            <span className="truncate text-right flex-1">{match.homeTeam}</span>
            <span className="text-xs uppercase text-muted-foreground shrink-0">vs</span>
            <span className="truncate flex-1">{match.awayTeam}</span>
          </DialogTitle>
          {hasScore && (
            <DialogDescription className="text-xs">
              {isLive ? "In play" : "HT"}: {match.htHomeScore ?? "?"}-{match.htAwayScore ?? "?"} · Corners: {match.corners ?? "?"} · Cards: {match.cards ?? "?"}
            </DialogDescription>
          )}
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="p-5 space-y-5">
            {/* Recent form */}
            {(match.homeForm || match.awayForm) && (
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md border border-border/50 p-3">
                  <div className="text-xs text-muted-foreground mb-1.5 truncate" title={match.homeTeam}>
                    {match.homeTeam} · Last 5
                  </div>
                  <FormBadges form={match.homeForm} />
                </div>
                <div className="rounded-md border border-border/50 p-3">
                  <div className="text-xs text-muted-foreground mb-1.5 truncate" title={match.awayTeam}>
                    {match.awayTeam} · Last 5
                  </div>
                  <FormBadges form={match.awayForm} />
                </div>
              </div>
            )}

            {/* Head-to-head */}
            {h2h && h2h.totalGames > 0 && (
              <div className="rounded-md border border-border/50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Head-to-Head ({h2h.totalGames} meetings)
                  </h3>
                  <div className="flex gap-1.5 text-[10px] font-semibold">
                    <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                      {match.homeTeam.split(" ")[0]}: {h2h.homeWins}
                    </Badge>
                    <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
                      Draws: {h2h.draws}
                    </Badge>
                    <Badge variant="outline" className="border-blue-500/40 text-blue-600 dark:text-blue-400">
                      {match.awayTeam.split(" ")[0]}: {h2h.awayWins}
                    </Badge>
                  </div>
                </div>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {h2h.lastMatches.slice(0, 8).map((m, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs py-1 border-b border-border/30 last:border-0">
                      <span className="text-muted-foreground font-mono text-[10px] w-24 shrink-0">
                        {m.date ? new Date(m.date).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" }) : "—"}
                      </span>
                      <span className="flex-1 truncate text-right" title={m.homeTeam}>{m.homeTeam}</span>
                      <span className={
                        "font-bold tabular-nums px-1.5 py-0.5 rounded text-[10px] " +
                        (m.result === "home"
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : m.result === "away"
                            ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                            : "bg-amber-500/15 text-amber-600 dark:text-amber-400")
                      }>
                        {m.homeScore}-{m.awayScore}
                      </span>
                      <span className="flex-1 truncate" title={m.awayTeam}>{m.awayTeam}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                All Markets ({sorted.length})
              </h3>
              <div className="space-y-1">
                {sorted.map((p) => (
                  <PredictionRow key={p.id} p={p} />
                ))}
                {sorted.length === 0 && (
                  <div className="text-sm text-muted-foreground italic py-3 text-center">
                    No predictions generated for this match.
                  </div>
                )}
              </div>
            </div>

            {match.rawPredictions.length > 0 && (
              <>
                <Separator />
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Source Breakdown
                  </h3>
                  <div className="space-y-2">
                    {match.rawPredictions.map((rp) => (
                      <div
                        key={rp.id}
                        className="flex items-center gap-3 py-2 px-3 rounded-md border border-border/50 text-sm"
                      >
                        <div className="flex-1">
                          <div className="font-semibold">{rp.source.displayName}</div>
                          <div className="text-xs text-muted-foreground">
                            Weight: {(rp.source.weight * 100).toFixed(0)}% · Accuracy: {(rp.source.accuracy * 100).toFixed(1)}%
                          </div>
                        </div>
                        <div className="flex gap-1.5">
                          {rp.predicted1X2 && <Badge variant="outline" className="text-[10px]">1X2: {rp.predicted1X2}</Badge>}
                          {rp.predictedScore && <Badge variant="outline" className="text-[10px]">Score: {rp.predictedScore}</Badge>}
                          {rp.predictedBTTS && <Badge variant="outline" className="text-[10px]">BTTS: {rp.predictedBTTS}</Badge>}
                          {rp.predictedOU25 && <Badge variant="outline" className="text-[10px]">O/U: {rp.predictedOU25}</Badge>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export { marketLabel };
