/**
 * GET /api/owner/unlock?token=<token>
 *
 * Validates the supplied token against SITE_OWNER_TOKEN env var. On success,
 * sets a 10-year HTTP-only signed cookie (`betiq_owner`) and redirects to `/`
 * (or to the `?next=` path if provided). On failure, returns 401.
 *
 * The owner only needs to visit this URL ONCE per browser. After that, the
 * cookie persists and the Won History tab auto-renders — no password modal,
 * no login flow, no friction. Same UX as the Performance tab being visible
 * only to them.
 *
 * Usage:
 *   - Visit: https://your-site.com/api/owner/unlock?token=YOUR_TOKEN
 *   - Or use ?next=/path to redirect somewhere specific after unlock
 *
 * To clear the cookie (log out), visit: /api/owner/lock
 */

import { NextRequest, NextResponse } from "next/server";
import {
  verifyOwnerToken,
  issueOwnerCookie,
  getOwnerToken,
} from "@/lib/admin/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token") ?? "";
  const next = searchParams.get("next") ?? "/";

  // Refuse unlock when no token is configured in production.
  if (process.env.NODE_ENV === "production" && !getOwnerToken()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Owner unlock is disabled. Set SITE_OWNER_TOKEN in the deployment environment variables to enable.",
      },
      { status: 503 }
    );
  }

  if (!verifyOwnerToken(token)) {
    // Slight delay to slow brute force.
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json(
      { ok: false, error: "Invalid token" },
      { status: 401 }
    );
  }

  await issueOwnerCookie();

  // Safe-redirect: only allow same-origin relative paths.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(new URL(safeNext, req.url));
}
