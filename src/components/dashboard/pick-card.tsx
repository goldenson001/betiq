"use client";

import { Badge } from "@/components/ui/badge";
import { Clock } from "lucide-react";
import { PredictionRow, type PredictionView } from "./prediction-row";
import { cn } from "@/lib/utils";

/**
 * Shared pick card used by the Safe High-Odds, Safe Picks, and Value Bets
 * tabs. Consolidates the previously triplicated markup:
 *   - kickoff-time + league-name header row
 *   - right-aligned status badges (TOP + per-tab status)
 *   - match name line
 *   - compact PredictionRow
 *
 * Tab-specific differences are passed as props:
 *   - `cardClassName`: accent border + bg (cyan for Safe High-Odds, neutral for others)
 *   - `statusBadge`: the right-side pill (SAFE HI-ODDS / SAFE-BEST / VALUE-BEST)
 *   - `prediction`: the fully-built PredictionView (parent decides flag mapping)
 *   - `disagreement`: optional — only Safe High-Odds passes this currently
 */
export interface PickCardProps {
  match: string;
  kickoffBrussels: string | null | undefined;
  league: string | null | undefined;
  isTopPick?: boolean;
  statusBadge?: React.ReactNode;
  cardClassName?: string;
  prediction: PredictionView;
}

export function PickCard({
  match,
  kickoffBrussels,
  league,
  isTopPick,
  statusBadge,
  cardClassName,
  prediction,
}: PickCardProps) {
  return (
    <div className={cn("rounded-md border px-3 py-2", cardClassName)}>
      <div className="flex items-center justify-between gap-2 mb-1.5 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5 min-w-0">
          <Clock className="h-3 w-3 shrink-0" />
          <span className="font-mono font-medium">{kickoffBrussels ?? "—"}</span>
          <span>·</span>
          <span className="truncate">{league ?? "—"}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isTopPick && (
            <Badge
              variant="outline"
              className="text-[9px] h-4 px-1 border-violet-400 text-violet-600 dark:text-violet-300 font-semibold"
            >
              TOP
            </Badge>
          )}
          {statusBadge}
        </div>
      </div>
      <div className="font-semibold text-xs mb-1.5 truncate">{match}</div>
      <PredictionRow p={prediction} compact />
    </div>
  );
}
