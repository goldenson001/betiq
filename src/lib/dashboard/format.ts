/**
 * Display helpers for the dashboard.
 */

export function confidenceColor(c: number): string {
  if (c >= 75) return "text-emerald-500 dark:text-emerald-400";
  if (c >= 60) return "text-lime-500 dark:text-lime-400";
  if (c >= 45) return "text-amber-500 dark:text-amber-400";
  return "text-rose-500 dark:text-rose-400";
}

export function confidenceBg(c: number): string {
  if (c >= 75) return "bg-emerald-500 dark:bg-emerald-400";
  if (c >= 60) return "bg-lime-500 dark:bg-lime-400";
  if (c >= 45) return "bg-amber-500 dark:bg-amber-400";
  return "bg-rose-500 dark:bg-rose-400";
}

export function edgeColor(edge?: number | null): string {
  if (edge === undefined || edge === null) return "text-muted-foreground";
  if (edge > 0.1) return "text-emerald-500 dark:text-emerald-400";
  if (edge > 0.03) return "text-lime-500 dark:text-lime-400";
  if (edge > 0) return "text-amber-500 dark:text-amber-400";
  return "text-rose-500 dark:text-rose-400";
}

export function formatOdds(o?: number | null): string {
  if (o === undefined || o === null) return "—";
  return o.toFixed(2);
}

export function formatPercent(p: number, digits: number = 0): string {
  return `${(p * 100).toFixed(digits)}%`;
}

export function marketLabel(market: string): string {
  const labels: Record<string, string> = {
    "1x2": "Match Result (1X2)",
    htft: "Half-time / Full-time",
    btts: "Both Teams to Score",
    win_btts: "Win + BTTS",
    ou15: "Over 1.5 Goals",
    ou25: "Over 2.5 Goals",
    ou35: "Over 3.5 Goals",
    asian_handicap: "Asian Handicap",
    corners_ou: "Corners Over/Under",
    corners_first: "First to N Corners",
    cards_ou: "Cards Over/Under",
    correct_score: "Correct Score",
    bet_builder: "Bet Builder",
  };
  return labels[market] ?? market;
}

export function selectionLabel(market: string, selection: string): string {
  if (market === "1x2") {
    if (selection === "1") return "Home Win";
    if (selection === "X") return "Draw";
    if (selection === "2") return "Away Win";
  }
  if (market === "btts") {
    return selection === "yes" ? "Yes — Both Score" : "No — Not Both";
  }
  if (market === "win_btts") {
    if (selection === "no") return "No — Neither Combo Hits";
    // Selections like "Arsenal win + BTTS" pass through
    return selection;
  }
  return selection;
}
