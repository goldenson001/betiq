/**
 * GET /api/admin/session
 * Returns whether the caller is currently authenticated as admin.
 * Response: 200 { ok: true, isAdmin: boolean }
 *
 * The client polls this on mount to learn whether to show admin UI without
 * having to make a heavier (admin-gated) request first.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { ok } = await requireAdmin(req);
  return NextResponse.json({ ok: true, isAdmin: ok });
}
