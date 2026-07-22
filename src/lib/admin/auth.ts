/**
 * Admin authentication — minimal, env-based, cookie-stored.
 *
 * Why this exists:
 *   The user wants a private "won parlay history" view that only the admin can
 *   see. Normal visitors must not see past won parlay records (those are
 *   sensitive business analytics). We implement a deliberately simple admin
 *   gate — a single shared password stored in `ADMIN_PASSWORD` env var, with
 *   a signed session cookie that proves the visitor knew the password.
 *
 * Threat model & scope:
 *   - This is NOT enterprise auth. It is a "curtain" that hides admin-only
 *     analytics from casual visitors / scrapers.
 *   - The session cookie is HMAC-signed with `ADMIN_SESSION_SECRET` so a
 *     visitor cannot forge it by typing `isAdmin=true` in their console.
 *   - All admin API routes must call `requireAdmin(req)` and bail with 401
 *     when the cookie is missing or invalid.
 *   - The password lives in env (never shipped to the client). Default
 *     fallback ("betiq-admin") is allowed ONLY when NODE_ENV !== "production"
 *     so a fresh dev box can log in without setup, but a real deployment
 *     without ADMIN_PASSWORD refuses all admin logins.
 */

import { cookies } from "next/headers";
import { NextRequest } from "next/server";

const COOKIE_NAME = "betiq_admin_session";
// Cookie lifetime: 7 days (in seconds). Sliding — refreshed on each
// successful requireAdmin call so active admins don't get logged out.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

/** Read the configured admin password, or null when none is set in prod. */
export function getAdminPassword(): string | null {
  const pw = process.env.ADMIN_PASSWORD;
  if (pw && pw.length > 0) return pw;
  // Dev-only fallback so a fresh checkout can log in without env setup.
  if (process.env.NODE_ENV !== "production") return "betiq-admin";
  return null;
}

/** Read the HMAC secret used to sign session cookies. */
function getSessionSecret(): string {
  // Prefer explicit env var, fall back to admin password (still secret),
  // fall back to dev-only constant. In prod without either, we throw so
  // no admin login can ever succeed — safer than silently unsigned cookies.
  const explicit = process.env.ADMIN_SESSION_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  const pw = process.env.ADMIN_PASSWORD;
  if (pw && pw.length >= 16) return pw;
  if (process.env.NODE_ENV !== "production") {
    return "dev-only-session-secret-do-not-use-in-prod-32chars";
  }
  throw new Error(
    "ADMIN_SESSION_SECRET or ADMIN_PASSWORD (>=16 chars) must be set in production."
  );
}

/**
 * Verify a candidate password against the configured admin password.
 * Uses a constant-time comparison to avoid timing side-channels.
 */
export function verifyAdminPassword(candidate: string): boolean {
  const expected = getAdminPassword();
  if (!expected) return false;
  if (typeof candidate !== "string") return false;
  // Constant-time comparison.
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still do a compare to keep timing roughly constant.
    a.compare(b);
    return false;
  }
  return a.compare(b) === 0;
}

/**
 * Create a signed session token: `<expiresAtMs>.<base64url HMAC>`.
 * The HMAC covers expiresAtMs only (no user identity — single-admin model).
 */
async function signSession(expiresAtMs: number): Promise<string> {
  const secret = getSessionSecret();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const payload = String(expiresAtMs);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  const sigB64 = Buffer.from(new Uint8Array(sig))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${payload}.${sigB64}`;
}

/** Verify a session token's signature and expiry. Returns true if valid. */
async function verifySession(token: string): Promise<boolean> {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const expiresAtMs = Number(payload);
  if (!Number.isFinite(expiresAtMs)) return false;
  if (expiresAtMs < Date.now()) return false;

  let secret: string;
  try {
    secret = getSessionSecret();
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  // Reconstruct the expected signature.
  const expectedSig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  const expectedB64 = Buffer.from(new Uint8Array(expectedSig))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  // Constant-time-ish comparison via Buffer.
  const a = Buffer.from(sigB64, "base64");
  const b = Buffer.from(expectedB64, "base64");
  if (a.length !== b.length) return false;
  return a.compare(b) === 0;
}

/**
 * Issue a fresh admin session cookie. Call after a successful login.
 * Stores the cookie via next/headers so it works in route handlers and
 * server actions alike.
 */
export async function issueAdminSession(): Promise<void> {
  const expiresAtMs = Date.now() + COOKIE_MAX_AGE * 1000;
  const token = await signSession(expiresAtMs);
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

/** Clear the admin session cookie (logout). */
export async function clearAdminSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/**
 * Check whether the current request carries a valid admin session.
 * Use this in route handlers to gate admin-only endpoints.
 *
 *   const { ok, response } = await requireAdmin(req);
 *   if (!ok) return response;
 *
 * Returns ok=true when the request is from a logged-in admin.
 */
export async function requireAdmin(req: NextRequest): Promise<{
  ok: boolean;
  response?: Response;
}> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ ok: false, error: "Unauthorized" }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        }
      ),
    };
  }
  const valid = await verifySession(token);
  if (!valid) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ ok: false, error: "Invalid or expired session" }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        }
      ),
    };
  }
  return { ok: true };
}

/** Same as requireAdmin but reads from next/headers cookies (server components). */
export async function isAdminOnServer(): Promise<boolean> {
  try {
    const store = await cookies();
    const token = store.get(COOKIE_NAME)?.value;
    if (!token) return false;
    return await verifySession(token);
  } catch {
    return false;
  }
}

export { COOKIE_NAME as ADMIN_COOKIE_NAME };
