"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Shared loading skeleton for the pick-list tabs (Safe High-Odds, Safe Picks,
 * Value Bets). Previously each tab inlined the same 5-row `h-16` Skeleton
 * stack — now consolidated to a single component.
 */
export function PickListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 rounded-md" />
      ))}
    </div>
  );
}

/**
 * Shared empty-state card for the pick-list tabs. Each tab passes its own
 * icon, title, body, and optional hint so the copy stays tab-specific while
 * the layout (centered icon + title + body + hint) is shared.
 */
export interface PickTabEmptyProps {
  icon: React.ReactNode;
  title: string;
  body?: string;
  hint?: string;
}

export function PickTabEmpty({ icon, title, body, hint }: PickTabEmptyProps) {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <div className="h-10 w-10 text-muted-foreground mx-auto mb-3 flex items-center justify-center">
          {icon}
        </div>
        <p className="text-sm font-medium">{title}</p>
        {body && (
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">{body}</p>
        )}
        {hint && <p className="text-xs text-muted-foreground mt-2">{hint}</p>}
      </CardContent>
    </Card>
  );
}
