/**
 * POST /api/admin/login
 * Body: { password: string }
 *
 * Verifies the password against ADMIN_PASSWORD env var. On success, issues
 * a signed HTTP-only session cookie (7-day lifetime).
 *
 * Returns 200 { ok: true } on success, 401 on bad password, 503 if no
 * ADMIN_PASSWORD is configured in production.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminPassword, issueAdminSession, getAdminPassword } from "@/lib/admin/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    return NextResponse.json(
      { ok: false, error: "Password required" },
      { status: 400 }
    );
  }

  // Refuse login when no admin password is configured in production — we
  // must not let the dev fallback ("betiq-admin") grant admin on a real
  // deployment that forgot to set ADMIN_PASSWORD.
  if (process.env.NODE_ENV === "production" && !getAdminPassword()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Admin login is disabled. Set ADMIN_PASSWORD in the deployment environment variables to enable.",
      },
      { status: 503 }
    );
  }

  if (!verifyAdminPassword(password)) {
    // Slight artificial delay to slow brute force (this is single-shared-pw
    // so we cannot lock accounts; rate-limit at edge if abuse ever happens).
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json(
      { ok: false, error: "Invalid password" },
      { status: 401 }
    );
  }

  await issueAdminSession();
  return NextResponse.json({ ok: true });
}
