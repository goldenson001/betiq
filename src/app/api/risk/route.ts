/**
 * GET /api/risk
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns the current risk state of the betting portfolio:
 *   - bankroll, peak, drawdown %, drawdown state
 *   - stake multiplier being applied to today's recommendations
 *   - today's total exposure (sum of recommended stakes for today's parlays)
 *   - pending / settled stake counts
 *
 * Used by the dashboard UI to show a risk banner: "Today's picks are running
 * at 50% Kelly (degraded state — 5-day losing streak)".
 */
import { NextResponse } from "next/server";
import { getBankrollState } from "@/lib/audit/bankroll";
import { db } from "@/lib/db";
import { brusselsDateString } from "@/lib/time/brussels";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await getBankrollState();

    // Today's exposure: sum of recommended stakes for today's parlays
    const today = brusselsDateString(new Date());
    const todayStakes = await db.stakeLedger.findMany({
      where: { matchDate: today },
      select: { recommendedStake: true, stakeAmount: true, status: true, tier: true },
    });

    const totalExposurePct = todayStakes
      .filter((s) => s.status === "recommended" || s.status === "placed")
      .reduce((sum, s) => sum + s.recommendedStake, 0);
    const totalExposureUnits = todayStakes
      .filter((s) => s.status === "recommended" || s.status === "placed")
      .reduce((sum, s) => sum + s.stakeAmount, 0);

    const byTier = new Map<string, { count: number; stake: number; amount: number }>();
    for (const s of todayStakes) {
      if (s.status !== "recommended" && s.status !== "placed") continue;
      const existing = byTier.get(s.tier) ?? { count: 0, stake: 0, amount: 0 };
      existing.count++;
      existing.stake += s.recommendedStake;
      existing.amount += s.stakeAmount;
      byTier.set(s.tier, existing);
    }

    const pendingCount = todayStakes.filter((s) => s.status === "recommended").length;
    const placedCount = todayStakes.filter((s) => s.status === "placed").length;
    const settledCount = todayStakes.filter((s) => s.status === "settled").length;

    return NextResponse.json({
      bankroll: {
        current: state.bankroll,
        peak: state.peakBankroll,
        drawdownPct: state.drawdownPct,
        drawdownState: state.drawdownState,
        stakeMultiplier: state.stakeMultiplier,
        reason: state.reason,
        winStreak: state.winStreak,
        loseStreak: state.loseStreak,
        lastSnapshotDate: state.lastSnapshotDate,
      },
      today: {
        date: today,
        totalExposurePct,
        totalExposureUnits,
        pendingPicks: pendingCount,
        placedPicks: placedCount,
        settledPicks: settledCount,
        byTier: Array.from(byTier.entries()).map(([tier, v]) => ({
          tier,
          count: v.count,
          stakePct: v.stake,
          stakeAmount: v.amount,
        })),
      },
      gates: {
        dailyMaxExposure: 0.15,
        drawdownDegradedPct: 0.10,
        drawdownHaltPct: 0.20,
        drawdownDegradedStreak: 5,
      },
    });
  } catch (err) {
    console.error("[/api/risk] error:", err);
    return NextResponse.json(
      { error: "Failed to load risk state", detail: String(err) },
      { status: 500 }
    );
  }
}
