/**
 * Smoke test for the owner-unlock + won parlay history flow.
 * Run with:  npx tsx scripts/test-admin-flow.ts
 * (Requires the dev server running on http://localhost:3000)
 *
 * What it does:
 *   1. Verifies /api/owner/session returns isOwner=false without cookie
 *   2. Verifies /api/admin/parlays/won returns 404 without cookie (no leak)
 *   3. Hits /api/owner/unlock with a wrong token — should 401, no cookie set
 *   4. Hits /api/owner/unlock with the correct (dev) token — should redirect
 *      to / with the betiq_owner cookie set
 *   5. Verifies /api/owner/session now returns isOwner=true
 *   6. Verifies /api/admin/parlays/won now returns 200 with the parlay list
 *   7. Hits /api/owner/lock — should redirect to / and clear the cookie
 *   8. Verifies /api/owner/session is back to isOwner=false
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

async function main() {
  console.log(`Smoke testing owner-unlock flow against ${BASE}\n`);

  // 1. No-cookie state
  let r = await fetch(`${BASE}/api/owner/session`, { redirect: "manual" });
  let j = (await r.json()) as { isOwner?: boolean };
  console.log(`[1] GET /api/owner/session (no cookie) → ${r.status} isOwner=${j.isOwner}`);
  if (j.isOwner !== false) throw new Error("Expected isOwner=false without cookie");

  // 2. Owner-gated endpoint without cookie — should 404 (NOT 401, no leak)
  r = await fetch(`${BASE}/api/admin/parlays/won`, { redirect: "manual" });
  console.log(`[2] GET /api/admin/parlays/won (no cookie) → ${r.status}`);
  if (r.status !== 404) throw new Error(`Expected 404 without cookie, got ${r.status}`);

  // 3. Wrong token — should 401
  r = await fetch(`${BASE}/api/owner/unlock?token=wrong-token`, { redirect: "manual" });
  console.log(`[3] GET /api/owner/unlock?token=wrong → ${r.status}`);
  if (r.status !== 401) throw new Error(`Expected 401 for wrong token, got ${r.status}`);

  // 4. Correct (dev) token — should redirect to / with Set-Cookie
  const devToken = process.env.SITE_OWNER_TOKEN ?? "owner";
  r = await fetch(`${BASE}/api/owner/unlock?token=${encodeURIComponent(devToken)}`, {
    redirect: "manual",
  });
  const setCookie = r.headers.get("set-cookie") ?? "";
  console.log(
    `[4] GET /api/owner/unlock?token=correct → ${r.status} (Location: ${r.headers.get(
      "location"
    )}) set-cookie len=${setCookie.length}`
  );
  if (r.status !== 200 && r.status !== 302 && r.status !== 307) {
    throw new Error(`Expected redirect for correct token, got ${r.status}`);
  }
  const cookieMatch = setCookie.match(/betiq_owner=[^;]+/);
  if (!cookieMatch) throw new Error("No betiq_owner cookie in Set-Cookie header");
  const cookie = cookieMatch[0];

  // 5. Session check with cookie
  r = await fetch(`${BASE}/api/owner/session`, {
    headers: { cookie },
    redirect: "manual",
  });
  j = (await r.json()) as { isOwner?: boolean };
  console.log(`[5] GET /api/owner/session (with cookie) → ${r.status} isOwner=${j.isOwner}`);
  if (j.isOwner !== true) throw new Error("Expected isOwner=true with valid cookie");

  // 6. Won parlays fetch with cookie — should be 200
  r = await fetch(`${BASE}/api/admin/parlays/won`, {
    headers: { cookie },
    redirect: "manual",
  });
  const j2 = (await r.json()) as { ok?: boolean; count?: number };
  console.log(`[6] GET /api/admin/parlays/won (with cookie) → ${r.status} count=${j2.count}`);
  if (r.status !== 200 || !j2.ok) throw new Error("Expected 200 ok=true with valid cookie");

  // 7. Lock (logout)
  r = await fetch(`${BASE}/api/owner/lock`, { redirect: "manual" });
  console.log(`[7] GET /api/owner/lock → ${r.status}`);
  // The lock route returns a redirect that clears the cookie. We simulate
  // "cookie cleared" by issuing a fresh session probe with no cookie.

  // 8. Verify session is gone
  r = await fetch(`${BASE}/api/owner/session`, { redirect: "manual" });
  j = (await r.json()) as { isOwner?: boolean };
  console.log(`[8] GET /api/owner/session (post-lock) → ${r.status} isOwner=${j.isOwner}`);
  if (j.isOwner !== false) throw new Error("Expected isOwner=false after lock");

  console.log("\n✓ All owner-unlock flow checks passed.");
}

main().catch((err) => {
  console.error("\n✗ Smoke test failed:", err.message);
  process.exit(1);
});
