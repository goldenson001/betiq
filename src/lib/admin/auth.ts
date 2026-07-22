/**
 * Owner authentication — URL-unlock + long-lived cookie.
 *
 * Why this exists:
 *   The user wants the "Won Parlays History" view to behave like the
 *   Performance tab — auto-visible to them (the site owner) without typing a
 *   password every time, but completely hidden from regular visitors.
 *
 *   Pattern: the owner sets `SITE_OWNER_TOKEN` in env. Once, they visit
 *   `/?unlock=<token>` (or any path with `?unlock=<token>`). The server
 *   validates the token, sets a 10-year HTTP-only cookie `betiq_owner`, and
 *   redirects to the page without the query param. From then on, that browser
 *   is permanently "unlocked" — no modal, no login, no friction, exactly
 *   like the Performance tab being visible only to them.
 *
 *   Regular visitors (no cookie) never see the Won History tab, the API
 *   returns 404, and the underlying fetch never fires.
 *
 * Threat model & scope:
 *   - This is a "soft" gate — a single shared token, not per-user accounts.
 *   - The cookie is HMAC-signed with `SITE_OWNER_TOKEN` so a visitor cannot
 *     forge it by editing their cookies.
 *   - All owner-gated API routes must call `requireOwner(req)` and bail with
 *     404 (not 401 — we don't even leak that the endpoint exists) when the
 *     cookie is missing or invalid.
 *   - In dev (NODE_ENV !== "production"), a default token "owner" is allowed
 *     so a fresh checkout works without env setup. In prod, no token = no
 *     unlock = no owner access.
 */

import { cookies } from "next/headers";
import { NextRequest } from "next/server";

const COOKIE_NAME = "betiq_owner";
// 10-year cookie lifetime — once unlocked, the owner never has to re-unlock
// on that device. They can manually clear via ?lock=1 if they want.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10;

/** Read the configured owner token, or null when none is set in prod. */
export function getOwnerToken(): string | null {
  const t = process.env.SITE_OWNER_TOKEN;
  if (t && t.length > 0) return t;
  // Dev-only fallback so a fresh checkout can unlock without env setup
  // by visiting /?unlock=owner
  if (process.env.NODE_ENV !== "production") return "owner";
  return null;
}

/**
 * Read the HMAC secret used to sign the owner cookie. Defaults to the token
 * itself when no separate secret is configured.
 */
function getCookieSecret(): string {
  const explicit = process.env.SITE_OWNER_COOKIE_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  const t = process.env.SITE_OWNER_TOKEN;
  if (t && t.length >= 16) return t;
  if (process.env.NODE_ENV !== "production") {
    return "dev-only-owner-cookie-secret-do-not-use-in-prod-32chars";
  }
  throw new Error(
    "SITE_OWNER_TOKEN or SITE_OWNER_COOKIE_SECRET (>=16 chars) must be set in production."
  );
}

/**
 * Constant-time comparison of two strings.
 */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    ba.compare(bb); // keep timing roughly constant
    return false;
  }
  return ba.compare(bb) === 0;
}

/** Verify a candidate token against the configured owner token. */
export function verifyOwnerToken(candidate: string): boolean {
  const expected = getOwnerToken();
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

/**
 * Create a signed cookie value: `<issuedAtMs>.<base64url HMAC>`.
 * The HMAC covers issuedAtMs only — single-owner model, no user identity.
 */
async function signCookie(issuedAtMs: number): Promise<string> {
  const secret = getCookieSecret();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const payload = String(issuedAtMs);
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

/** Verify a cookie value's signature. (No expiry — cookie is intentionally long-lived.) */
async function verifyCookie(value: string): Promise<boolean> {
  if (!value || typeof value !== "string") return false;
  const dot = value.indexOf(".");
  if (dot === -1) return false;
  const payload = value.slice(0, dot);
  const sigB64 = value.slice(dot + 1);
  const issuedAtMs = Number(payload);
  if (!Number.isFinite(issuedAtMs)) return false;
  // Sanity: issuedAt shouldn't be in the future (clock-skew tolerance: 1 day)
  if (issuedAtMs > Date.now() + 86_400_000) return false;

  let secret: string;
  try {
    secret = getCookieSecret();
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
  return safeEqual(sigB64, expectedB64);
}

/**
 * Issue the owner cookie. Call after validating `?unlock=<token>`.
 * Sets the cookie via next/headers so it works in route handlers + middleware.
 */
export async function issueOwnerCookie(): Promise<void> {
  const issuedAtMs = Date.now();
  const value = await signCookie(issuedAtMs);
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

/** Clear the owner cookie. Call when the owner visits `?lock=1`. */
export async function clearOwnerCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/**
 * Server-side check (for server components / route handlers reading
 * next/headers cookies): is this visitor the site owner?
 */
export async function isOwnerOnServer(): Promise<boolean> {
  try {
    const store = await cookies();
    const c = store.get(COOKIE_NAME)?.value;
    if (!c) return false;
    return await verifyCookie(c);
  } catch {
    return false;
  }
}

/**
 * Route-handler check. Returns 404 (NOT 401) when not the owner — we don't
 * want to leak the existence of admin endpoints to scrapers.
 *
 *   const { ok, response } = await requireOwner(req);
 *   if (!ok) return response;
 */
export async function requireOwner(req: NextRequest): Promise<{
  ok: boolean;
  response?: Response;
}> {
  const c = req.cookies.get(COOKIE_NAME)?.value;
  if (!c) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ ok: false, error: "Not found" }),
        { status: 404, headers: { "content-type": "application/json" } }
      ),
    };
  }
  const valid = await verifyCookie(c);
  if (!valid) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ ok: false, error: "Not found" }),
        { status: 404, headers: { "content-type": "application/json" } }
      ),
    };
  }
  return { ok: true };
}

export { COOKIE_NAME as OWNER_COOKIE_NAME };
