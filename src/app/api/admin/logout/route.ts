/**
 * POST /api/admin/logout
 * Clears the admin session cookie. Always returns 200 (idempotent).
 */

import { NextResponse } from "next/server";
import { clearAdminSession } from "@/lib/admin/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearAdminSession();
  return NextResponse.json({ ok: true });
}
