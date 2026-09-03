import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createApiKey } from "../src/db/apiKeys.js";
import { createPool } from "../src/db/pool.js";
import { registerWebhook } from "../src/db/webhooks.js";
import { ADMIN_SESSION_COOKIE } from "../src/lib/adminAuth.js";

// Real integration tests against Postgres, matching test/waitlist.test.ts's
// and test/webhooks.test.ts's pattern. Truncates the same table set as
// test/db-api-keys.test.ts/test/api-key-auth.test.ts/test/rate-limit.test.ts
// (api_key_usage, api_keys) plus waitlist and wallets (which cascades to
// webhooks) -- safe because vitest.config.ts turns off file parallelism, so
// these files never run concurrently against the shared DB.
const pool = createPool();

// Matches vitest.config.ts's ADMIN_PASSWORD_HASH -- that's the scrypt hash
// of this exact plaintext. Set explicitly there (rather than relying on
// src/config.ts's own dev default, which happens to be the same value) so
// this suite doesn't silently depend on a coincidence.
const ADMIN_PASSWORD = "admin-dev-password";

/** Logs in as the configured admin and returns cookies for app.inject(). */
async function loginAsAdmin(app: Awaited<ReturnType<typeof buildApp>>): Promise<Record<string, string>> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/login",
    payload: { username: config.ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  const cookie = res.cookies.find((c) => c.name === ADMIN_SESSION_COOKIE);
  if (!cookie) {
    throw new Error(`login did not set a session cookie (status ${res.statusCode}): ${res.body}`);
  }
  return { [ADMIN_SESSION_COOKIE]: cookie.value };
}

beforeEach(async () => {
  await pool.query("truncate table api_key_usage, api_keys cascade");
  await pool.query("truncate table waitlist");
  await pool.query("truncate table wallets cascade");
});

afterAll(async () => {
  await pool.end();
});

describe("admin routes", () => {
  it("reject requests with no session cookie", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/admin/overview" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("reject a real per-customer API key -- it's not checked at all anymore", async () => {
    const app = await buildApp();
    const { plaintext } = await createApiKey(pool, "customer@example.com", "growth");

    const res = await app.inject({
      method: "GET",
      url: "/admin/overview",
      headers: { "x-api-key": plaintext },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("POST /admin/login rejects a wrong username or a wrong password", async () => {
    const app = await buildApp();

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: config.ADMIN_USERNAME, password: "not-it" },
    });
    expect(wrongPassword.statusCode).toBe(401);

    const wrongUsername = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: "not-admin", password: ADMIN_PASSWORD },
    });
    expect(wrongUsername.statusCode).toBe(401);

    await app.close();
  });

  it("POST /admin/login accepts the configured credentials and sets an HttpOnly session cookie", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { username: config.ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);

    const cookie = res.cookies.find((c) => c.name === ADMIN_SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);

    const authed = await app.inject({
      method: "GET",
      url: "/admin/session",
      cookies: { [ADMIN_SESSION_COOKIE]: cookie!.value },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toEqual({ authenticated: true });

    await app.close();
  });

  it("rejects a tampered session cookie", async () => {
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);

    const res = await app.inject({
      method: "GET",
      url: "/admin/overview",
      cookies: { [ADMIN_SESSION_COOKIE]: `${cookies[ADMIN_SESSION_COOKIE]}x` },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("POST /admin/logout clears the cookie -- a request that no longer sends it is unauthenticated", async () => {
    // Sessions are stateless (no server-side store to revoke against --
    // see adminAuth.ts's top comment), so logout can only ever clear the
    // browser's copy of the cookie, not invalidate the token itself. This
    // asserts the actual guarantee: clearCookie's response, and that a
    // request sending no cookie afterward is rejected -- not that the old
    // token has been server-side revoked, which it hasn't.
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);

    const before = await app.inject({ method: "GET", url: "/admin/session", cookies });
    expect(before.statusCode).toBe(200);

    const logout = await app.inject({ method: "POST", url: "/admin/logout", cookies });
    expect(logout.statusCode).toBe(200);
    // clearCookie sends an already-expired, empty-value cookie -- the
    // browser (and app.inject's cookie jar) then stops sending it.
    const cleared = logout.cookies.find((c) => c.name === ADMIN_SESSION_COOKIE);
    expect(cleared?.value).toBe("");

    const after = await app.inject({ method: "GET", url: "/admin/session" });
    expect(after.statusCode).toBe(401);

    await app.close();
  });

  it("GET /admin/overview reflects real counts across api keys, waitlist, and webhooks", async () => {
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);

    await createApiKey(pool, "one@example.com", "free");
    const { record: revokedKey } = await createApiKey(pool, "two@example.com", "builder");
    await app.inject({
      method: "POST",
      url: `/admin/api-keys/${revokedKey.id}/revoke`,
      cookies,
    });

    await app.inject({ method: "POST", url: "/waitlist", payload: { email: "waiter@example.com" } });

    await registerWebhook(pool, { chain: "solana", wallet: "wallet-a", url: "https://example.com/hook", threshold_pct: 5 });

    const res = await app.inject({ method: "GET", url: "/admin/overview", cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.apiKeys).toEqual({ total: 2, active: 1 });
    expect(body.waitlist.total).toBe(1);
    expect(body.waitlist.recent).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: "waiter@example.com" })]),
    );
    expect(body.webhooks).toEqual({ total: 1 });

    await app.close();
  });

  it("GET /admin/api-keys lists keys and supports filtering by email", async () => {
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);
    await createApiKey(pool, "alice@example.com", "free");
    await createApiKey(pool, "bob@example.com", "builder");

    const all = await app.inject({ method: "GET", url: "/admin/api-keys", cookies });
    expect(all.json().apiKeys).toHaveLength(2);

    const filtered = await app.inject({
      method: "GET",
      url: "/admin/api-keys?email=alice@example.com",
      cookies,
    });
    expect(filtered.json().apiKeys).toHaveLength(1);
    expect(filtered.json().apiKeys[0]).toMatchObject({ ownerEmail: "alice@example.com" });

    await app.close();
  });

  it("POST /admin/api-keys issues a new key and returns the plaintext once", async () => {
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/admin/api-keys",
      cookies,
      payload: { email: "partner@example.com", tier: "builder" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.apiKey).toMatchObject({ ownerEmail: "partner@example.com", tier: "builder", revokedAt: null });
    expect(typeof body.plaintext).toBe("string");
    expect(body.plaintext.length).toBeGreaterThan(10);

    await app.close();
  });

  it("rejects an invalid tier when creating a key", async () => {
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/admin/api-keys",
      cookies,
      payload: { email: "partner@example.com", tier: "enterprise" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /admin/api-keys/:id/rotate revokes the old key and issues a new one", async () => {
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);
    const { record } = await createApiKey(pool, "rotate-me@example.com", "free");

    const res = await app.inject({
      method: "POST",
      url: `/admin/api-keys/${record.id}/rotate`,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.apiKey.id).not.toBe(record.id);
    expect(body.apiKey.ownerEmail).toBe("rotate-me@example.com");
    expect(typeof body.plaintext).toBe("string");

    const list = await app.inject({ method: "GET", url: "/admin/api-keys", cookies });
    const old = list.json().apiKeys.find((k: { id: string }) => k.id === record.id);
    expect(old.revokedAt).not.toBeNull();

    await app.close();
  });

  it("POST /admin/api-keys/:id/revoke is idempotent and 404s the second time", async () => {
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);
    const { record } = await createApiKey(pool, "revoke-me@example.com", "free");

    const first = await app.inject({
      method: "POST",
      url: `/admin/api-keys/${record.id}/revoke`,
      cookies,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ revoked: true });

    const second = await app.inject({
      method: "POST",
      url: `/admin/api-keys/${record.id}/revoke`,
      cookies,
    });
    expect(second.statusCode).toBe(404);

    await app.close();
  });

  it("404s on a malformed or unknown api key id instead of 500ing", async () => {
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);

    const malformed = await app.inject({
      method: "POST",
      url: "/admin/api-keys/not-a-uuid/revoke",
      cookies,
    });
    expect(malformed.statusCode).toBe(404);

    const unknown = await app.inject({
      method: "POST",
      url: "/admin/api-keys/00000000-0000-0000-0000-000000000000/rotate",
      cookies,
    });
    expect(unknown.statusCode).toBe(404);

    await app.close();
  });

  it("GET /admin/webhooks and GET /admin/waitlist return real data", async () => {
    const app = await buildApp();
    const cookies = await loginAsAdmin(app);
    await registerWebhook(pool, { chain: "solana", wallet: "wallet-b", url: "https://example.com/hook", threshold_pct: 10 });
    await app.inject({ method: "POST", url: "/waitlist", payload: { email: "seen@example.com" } });

    const webhooks = await app.inject({ method: "GET", url: "/admin/webhooks", cookies });
    expect(webhooks.json().webhooks).toHaveLength(1);

    const waitlist = await app.inject({ method: "GET", url: "/admin/waitlist", cookies });
    expect(waitlist.json().entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: "seen@example.com" })]),
    );

    await app.close();
  });
});
