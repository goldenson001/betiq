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

export function MatchDetailDialog({ match, open, onOpenChange }: Props) {
  if (!match) return null;
  const sorted = [...match.predictions].sort(
    (a, b) => MARKET_ORDER.indexOf(a.market) - MARKET_ORDER.indexOf(b.market) || b.confidence - a.confidence
  );
  const hasResult = match.status === "finished" && match.homeScore !== null && match.awayScore !== null;

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
          </div>
          <DialogTitle className="text-lg sm:text-xl flex items-center justify-between gap-3">
            <span className="truncate text-right flex-1">{match.homeTeam}</span>
            <span className="text-xs uppercase text-muted-foreground shrink-0">vs</span>
            <span className="truncate flex-1">{match.awayTeam}</span>
          </DialogTitle>
          {hasResult && (
            <DialogDescription className="text-xs">
              HT: {match.htHomeScore ?? "?"}-{match.htAwayScore ?? "?"} · Corners: {match.corners ?? "?"} · Cards: {match.cards ?? "?"}
            </DialogDescription>
          )}
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="p-5 space-y-5">
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
