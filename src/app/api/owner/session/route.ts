/**
 * GET /api/owner/session
 * Returns whether the caller is the site owner (has the betiq_owner cookie).
 * Response: 200 { ok: true, isOwner: boolean }
 *
 * The client polls this on mount to decide whether to render the Won History
 * tab — same pattern the Performance tab uses, just gated by the cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/admin/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { ok } = await requireOwner(req);
  return NextResponse.json({ ok: true, isOwner: ok });
}
