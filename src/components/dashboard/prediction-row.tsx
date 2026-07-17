"use client";

import { cn } from "@/lib/utils";
import { confidenceColor, confidenceBg, formatOdds, edgeColor, marketLabel, selectionLabel } from "@/lib/dashboard/format";

export interface PredictionView {
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
  sourcesJson: string | null;
}

export function PredictionRow({ p, compact = false }: { p: PredictionView; compact?: boolean }) {
  const isValue = p.isValueBet;
  const isTop = p.isTopPick;
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2.5 rounded-md border border-border/50 transition-colors hover:bg-accent/30",
        compact ? "py-1.5" : "py-2",
        isTop && "bg-primary/5 border-primary/40",
        isValue && "ring-1 ring-amber-400/40"
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            {marketLabel(p.market)}
          </span>
          {isTop && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-primary-foreground bg-primary px-1 py-0.5 rounded">
              Top
            </span>
          )}
          {isValue && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-amber-950 bg-amber-400 px-1 py-0.5 rounded">
              VALUE
            </span>
          )}
        </div>
        <div className="text-xs sm:text-sm font-semibold truncate mt-0.5">
          {selectionLabel(p.market, p.selection)}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <div className="text-right">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">Odds</div>
          <div className="text-xs sm:text-sm font-mono font-semibold tabular-nums">
            {formatOdds(p.bookOdds)}
          </div>
        </div>
        <div className="text-right hidden sm:block w-12">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">Edge</div>
          <div className={cn("text-xs font-mono font-semibold tabular-nums", edgeColor(p.edge))}>
            {p.edge !== null && p.edge !== undefined
              ? `${p.edge > 0 ? "+" : ""}${(p.edge * 100).toFixed(1)}%`
              : "—"}
          </div>
        </div>
        <div className="text-right w-11">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">Conf.</div>
          <div className={cn("text-sm font-bold tabular-nums leading-tight", confidenceColor(p.confidence))}>
            {p.confidence}%
          </div>
        </div>
        <div className="w-1.5 h-7 rounded-full bg-muted overflow-hidden hidden sm:block">
          <div
            className={cn("h-full transition-all", confidenceBg(p.confidence))}
            style={{ width: `${p.confidence}%` }}
          />
        </div>
      </div>
    </div>
  );
}
