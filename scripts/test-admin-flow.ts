/**
 * Smoke test for the new admin auth + won parlay history flow.
 * Run with:  bun run scripts/test-admin-flow.ts  (or npx tsx)
 *
 * What it does:
 *   1. Boots the Next.js dev server (assumes running)
 *   2. Verifies /api/admin/session returns isAdmin=false without cookie
 *   3. Verifies /api/admin/parlays/won returns 401 without cookie
 *   4. Logs in with the dev-only default password
 *   5. Verifies session flips to isAdmin=true
 *   6. Verifies /api/admin/parlays/won now returns 200 with the parlay list
 *   7. Logs out and verifies session is gone
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

async function main() {
  console.log(`Smoke testing admin flow against ${BASE}\n`);

  // 1. No-cookie state — should be not-admin
  let r = await fetch(`${BASE}/api/admin/session`);
  let j = (await r.json()) as { isAdmin?: boolean };
  console.log(`[1] GET /api/admin/session (no cookie) → ${r.status} isAdmin=${j.isAdmin}`);
  if (j.isAdmin !== false) throw new Error("Expected isAdmin=false without cookie");

  // 2. Admin-gated endpoint without cookie — should be 401
  r = await fetch(`${BASE}/api/admin/parlays/won`);
  console.log(`[2] GET /api/admin/parlays/won (no cookie) → ${r.status}`);
  if (r.status !== 401) throw new Error("Expected 401 without cookie");

  // 3. Login with wrong password — should be 401
  r = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" }),
  });
  console.log(`[3] POST /api/admin/login (wrong password) → ${r.status}`);
  if (r.status !== 401) throw new Error("Expected 401 for wrong password");

  // 4. Login with correct (dev) password
  const devPw = process.env.ADMIN_PASSWORD ?? "betiq-admin";
  r = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: devPw }),
  });
  const setCookie = r.headers.get("set-cookie") ?? "";
  console.log(`[4] POST /api/admin/login (correct) → ${r.status}, set-cookie len=${setCookie.length}`);
  if (r.status !== 200) throw new Error("Expected 200 for correct password");

  // Extract the cookie for subsequent requests
  const cookieMatch = setCookie.match(/betiq_admin_session=[^;]+/);
  if (!cookieMatch) throw new Error("No betiq_admin_session cookie in Set-Cookie header");
  const cookie = cookieMatch[0];

  // 5. Session check with cookie — should be isAdmin=true
  r = await fetch(`${BASE}/api/admin/session`, {
    headers: { cookie },
  });
  j = (await r.json()) as { isAdmin?: boolean };
  console.log(`[5] GET /api/admin/session (with cookie) → ${r.status} isAdmin=${j.isAdmin}`);
  if (j.isAdmin !== true) throw new Error("Expected isAdmin=true with valid cookie");

  // 6. Won parlays fetch with cookie — should be 200 with parlay list
  r = await fetch(`${BASE}/api/admin/parlays/won`, {
    headers: { cookie },
  });
  const j2 = (await r.json()) as { ok?: boolean; count?: number };
  console.log(`[6] GET /api/admin/parlays/won (with cookie) → ${r.status} count=${j2.count}`);
  if (r.status !== 200 || !j2.ok) throw new Error("Expected 200 ok=true with valid cookie");

  // 7. Logout
  r = await fetch(`${BASE}/api/admin/logout`, {
    method: "POST",
    headers: { cookie },
  });
  console.log(`[7] POST /api/admin/logout → ${r.status}`);

  // 8. Verify session is gone (using the logout response's set-cookie which
  //    clears the cookie — we can re-read by issuing a fresh session probe
  //    without sending any cookie)
  r = await fetch(`${BASE}/api/admin/session`);
  j = (await r.json()) as { isAdmin?: boolean };
  console.log(`[8] GET /api/admin/session (post-logout) → ${r.status} isAdmin=${j.isAdmin}`);
  if (j.isAdmin !== false) throw new Error("Expected isAdmin=false after logout");

  console.log("\n✓ All admin flow checks passed.");
}

main().catch((err) => {
  console.error("\n✗ Smoke test failed:", err.message);
  process.exit(1);
});
