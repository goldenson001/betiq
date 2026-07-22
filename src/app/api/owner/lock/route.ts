/**
 * GET /api/owner/lock
 * Clears the owner cookie. Useful when the owner wants to log out on a shared
 * device. Always redirects to `/`.
 */

import { NextRequest, NextResponse } from "next/server";
import { clearOwnerCookie } from "@/lib/admin/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await clearOwnerCookie();
  return NextResponse.redirect(new URL("/", req.url));
}
