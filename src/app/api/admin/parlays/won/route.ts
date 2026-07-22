/**
 * GET /api/admin/parlays/won
 *
 * Admin-only. Returns ALL settled-and-won parlays from the entire DB history,
 * sorted by date desc (most recent first). Each row carries:
 *   - parlay metadata (type, combinedOdds, combinedProbability, legsCount, …)
 *   - parsed legs (with matchLabel so the admin can read it without a join)
 *   - settled evaluation (legsWon/legsLost/legsVoid, actualReturn, realizedRoi)
 *     when available from PickAudit
 *
 * Optional query params:
 *   - limit=    cap on number of rows (default 200, max 1000)
 *   - tier=     filter by parlay type (safest | medium_risk | odds_3_a | …)
 *   - since=    ISO date YYYY-MM-DD — only parlays with matchDate >= since
 *
 * Response shape:
 *   { ok: true, count: number, parlays: WonParlayView[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/auth";

export const dynamic = "force-dynamic";

interface WonParlayLeg {
  predictionId: string;
  matchId: string;
  matchLabel: string;
  market: string;
  selection: string;
  odds: number;
  probability: number;
  confidence: number;
}

interface WonParlayView {
  id: string;
  matchDate: string;
  type: string;
  legsCount: number;
  combinedProbability: number;
  combinedOdds: number;
  confidence: number;
  expectedValue: number;
  kellyFraction: number | null;
  recommendedStake: number | null;
  mlScore: number | null;
  mlAdjustedProbability: number | null;
  mlSampleCount: number | null;
  evaluated: boolean;
  won: boolean | null;
  createdAt: string;
  legs: WonParlayLeg[];
  // ── Optional settlement info (joined from PickAudit) ────────────────────
  settlement?: {
    legsWon: number | null;
    legsLost: number | null;
    legsVoid: number | null;
    actualReturn: number | null;
    realizedRoi: number | null;
    settledAt: string | null;
    notes: string | null;
  } | null;
}

export async function GET(req: NextRequest) {
  // ── Auth gate ─────────────────────────────────────────────────────────
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response!;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(
    1000,
    Math.max(1, parseInt(searchParams.get("limit") ?? "200", 10) || 200)
  );
  const tier = searchParams.get("tier");
  const since = searchParams.get("since"); // YYYY-MM-DD or null

  try {
    const where: {
      evaluated: boolean;
      won: boolean;
      type?: string;
      matchDate?: { gte: string };
    } = {
      evaluated: true,
      won: true,
    };
    if (tier && tier.length > 0) where.type = tier;
    if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
      where.matchDate = { gte: since };
    }

    const parlays = await db.parlay.findMany({
      where,
      orderBy: [{ matchDate: "desc" }, { createdAt: "desc" }],
      take: limit,
    });

    // Best-effort: also pull matching PickAudit rows for settlement detail.
    // PickAudit.parlayId is loose (rows persist after Parlay is wiped), so we
    // can LEFT JOIN by parlayId. Some old parlays may not have an audit row.
    const parlayIds = parlays.map((p) => p.id);
    const audits = parlayIds.length > 0
      ? await db.pickAudit.findMany({
          where: { parlayId: { in: parlayIds } },
          orderBy: { settledAt: "desc" },
        })
      : [];
    const auditByParlay = new Map(audits.map((a) => [a.parlayId, a]));

    const out: WonParlayView[] = parlays.map((p) => {
      let legs: WonParlayLeg[] = [];
      try {
        legs = JSON.parse(p.legsJson) as WonParlayLeg[];
      } catch {
        legs = [];
      }
      const audit = auditByParlay.get(p.id) ?? null;
      return {
        id: p.id,
        matchDate: p.matchDate,
        type: p.type,
        legsCount: p.legsCount,
        combinedProbability: p.combinedProbability,
        combinedOdds: p.combinedOdds,
        confidence: p.confidence,
        expectedValue: p.expectedValue,
        kellyFraction: p.kellyFraction,
        recommendedStake: p.recommendedStake,
        mlScore: p.mlScore,
        mlAdjustedProbability: p.mlAdjustedProbability,
        mlSampleCount: p.mlSampleCount,
        evaluated: p.evaluated,
        won: p.won,
        createdAt: p.createdAt.toISOString(),
        legs,
        settlement: audit
          ? {
              legsWon: audit.legsWon,
              legsLost: audit.legsLost,
              legsVoid: audit.legsVoid,
              actualReturn: audit.actualReturn,
              realizedRoi: audit.realizedRoi,
              settledAt: audit.settledAt ? audit.settledAt.toISOString() : null,
              notes: audit.notes,
            }
          : null,
      };
    });

    return NextResponse.json({ ok: true, count: out.length, parlays: out });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: "Failed to load won parlay history", detail: msg },
      { status: 500 }
    );
  }
}
