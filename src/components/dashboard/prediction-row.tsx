"use client";

import { cn } from "@/lib/utils";
import { confidenceColor, confidenceBg, formatOdds, edgeColor, marketLabel, selectionLabel, formatKelly, formatClv, clvColor } from "@/lib/dashboard/format";

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
  /** True when this is the lower-risk side of its market (prob >= 0.55 binary / >= 0.50 1X2). */
  isSafePick?: boolean;
  /**
   * True when this pick combines HIGHER ODDS (1.50–2.50) with ALL safety
   * precautions: multi-source consensus, strong edge, positive Kelly, safe
   * market. Investment-grade higher-odds picks.
   */
  isSafeHighOdds?: boolean;
  /** Number of distinct sources agreeing on this pick. */
  consensusSources?: number;
  /**
   * C2: Source disagreement — stdev of per-source probabilities for this pick.
   * Low (< 0.08) = sources agree (reliable), high (> 0.15) = sources disagree
   * ("lottery 62%" picks). Undefined when sources don't expose probabilities.
   */
  disagreement?: number | null;
  sourcesJson: string | null;
  /** Kelly criterion recommended stake (fraction of bankroll, 0-0.05). Null if not computed. */
  recommendedStake?: number | null;
  /** Closing Line Value — did our pick beat the closing line? Null if not computed. */
  clv?: number | null;
  /** Whether this prediction has been evaluated against actual result. */
  evaluated?: boolean;
  correct?: boolean | null;
}

/**
 * C2: Render a small 3-dot indicator showing source disagreement.
 *   Green  (●●●) = stdev < 0.08 — sources agree (reliable)
 *   Amber (●●○) = stdev 0.08-0.15 — moderate disagreement
 *   Red    (●○○) = stdev > 0.15 — strong disagreement (lottery pick)
 */
function DisagreementIndicator({ disagreement }: { disagreement: number }) {
  const level = disagreement < 0.08 ? "agree" : disagreement < 0.15 ? "moderate" : "disagree";
  const color = level === "agree" ? "text-emerald-500" : level === "moderate" ? "text-amber-500" : "text-rose-500";
  const label = level === "agree" ? "Sources agree" : level === "moderate" ? "Sources differ" : "Sources disagree";
  return (
    <span
      className={`text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded border ${color} border-current/40`}
      title={`${label} (stdev ${(disagreement * 100).toFixed(1)}%)`}
    >
      {level === "agree" ? "AGREE" : level === "moderate" ? "MIXED" : "SPLIT"}
    </span>
  );
}

export function PredictionRow({ p, compact = false }: { p: PredictionView; compact?: boolean }) {
  const isValue = p.isValueBet;
  const isTop = p.isTopPick;
  const isSafe = p.isSafePick === true;
  const isSafeHighOdds = p.isSafeHighOdds === true;
  const hasKelly = p.recommendedStake !== undefined && p.recommendedStake !== null && p.recommendedStake > 0;
  const hasClv = p.clv !== undefined && p.clv !== null;
  const consensus = p.consensusSources ?? 0;
  const hasDisagreement = p.disagreement !== undefined && p.disagreement !== null;
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2.5 rounded-md border border-border/50 transition-colors hover:bg-accent/30",
        compact ? "py-1.5" : "py-2",
        isTop && "bg-primary/5 border-primary/40",
        isSafeHighOdds && "bg-cyan-500/5 border-cyan-500/40 ring-1 ring-cyan-400/30",
        isValue && !isSafeHighOdds && "ring-1 ring-amber-400/40",
        isSafe && !isTop && !isSafeHighOdds && "bg-emerald-500/5 border-emerald-500/30"
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
          {isSafeHighOdds && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-cyan-950 bg-cyan-400 px-1 py-0.5 rounded">
              SAFE HI-ODDS
            </span>
          )}
          {isSafe && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-950 bg-emerald-400 px-1 py-0.5 rounded">
              SAFE
            </span>
          )}
          {isValue && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-amber-950 bg-amber-400 px-1 py-0.5 rounded">
              VALUE
            </span>
          )}
          {consensus >= 3 && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-purple-950 bg-purple-300 px-1 py-0.5 rounded">
              {consensus}× CONSENSUS
            </span>
          )}
          {/* C2: Source disagreement indicator */}
          {hasDisagreement && <DisagreementIndicator disagreement={p.disagreement!} />}
          {hasKelly && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-blue-950 bg-blue-300 px-1 py-0.5 rounded">
              STAKE {formatKelly(p.recommendedStake)}
            </span>
          )}
          {p.evaluated && p.correct !== null && p.correct !== undefined && (
            <span className={cn(
              "text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded",
              p.correct ? "bg-emerald-500 text-white" : "bg-rose-500 text-white"
            )}>
              {p.correct ? "WON" : "LOST"}
            </span>
          )}
        </div>
        <div className="text-xs sm:text-sm font-semibold truncate mt-0.5">
          {selectionLabel(p.market, p.selection)}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        {hasClv && (
          <div className="text-right hidden md:block w-12">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">CLV</div>
            <div className={cn("text-xs font-mono font-semibold tabular-nums", clvColor(p.clv))}>
              {formatClv(p.clv)}
            </div>
          </div>
        )}
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
