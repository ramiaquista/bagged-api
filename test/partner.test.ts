import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createApiKey } from "../src/db/apiKeys.js";
import { createPool } from "../src/db/pool.js";
import { PARTNER_SESSION_COOKIE } from "../src/lib/partnerAuth.js";
import { PARTNER_MAX_ACTIVE_KEYS } from "../src/routes/partner.js";

// Real integration tests against Postgres, matching test/admin.test.ts's
// pattern. `truncate table partners cascade` alone is enough: api_keys
// references partners, and api_key_usage/api_request_log both reference
// api_keys, so CASCADE sweeps all four transitively (see db/schema.sql).
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table partners cascade");
});

afterAll(async () => {
  await pool.end();
});

const SIGNUP_BODY = { email: "dev@partner-co.example", password: "correct-horse-battery" };

/** Signs up a fresh partner and returns cookies for app.inject() plus the response body. */
async function signup(
  app: Awaited<ReturnType<typeof buildApp>>,
  body: Record<string, unknown> = SIGNUP_BODY,
) {
  const res = await app.inject({ method: "POST", url: "/partner/signup", payload: body });
  const cookie = res.cookies.find((c) => c.name === PARTNER_SESSION_COOKIE);
  if (res.statusCode !== 201 || !cookie) {
    throw new Error(`signup did not succeed (status ${res.statusCode}): ${res.body}`);
  }
  return { cookies: { [PARTNER_SESSION_COOKIE]: cookie.value }, body: res.json() };
}

describe("partner signup", () => {
  it("creates an account, issues a free-tier key, and signs the caller in", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/partner/signup", payload: SIGNUP_BODY });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.partner).toMatchObject({ email: SIGNUP_BODY.email, companyName: null });
    expect(body.partner.passwordHash).toBeUndefined();
    expect(body.apiKey).toMatchObject({ tier: "free", ownerEmail: SIGNUP_BODY.email, partnerId: body.partner.id });
    expect(typeof body.plaintext).toBe("string");
    expect(body.plaintext.startsWith("bg_")).toBe(true);

    const cookie = res.cookies.find((c) => c.name === PARTNER_SESSION_COOKIE);
    expect(cookie).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);

    await app.close();
  });

  it("rejects a duplicate email", async () => {
    const app = await buildApp();
    await signup(app);

    const res = await app.inject({ method: "POST", url: "/partner/signup", payload: SIGNUP_BODY });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/already exists/i);

    await app.close();
  });

  it("rejects a too-short password", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/partner/signup",
      payload: { email: "short@partner-co.example", password: "abc" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("lowercases and trims the email, and stores an optional company name", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/partner/signup",
      payload: { email: "  Mixed@Partner-Co.example  ", password: "correct-horse-battery", companyName: "Acme" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().partner).toMatchObject({ email: "mixed@partner-co.example", companyName: "Acme" });
    await app.close();
  });
});

describe("partner login", () => {
  it("signs in with the right password", async () => {
    const app = await buildApp();
    await signup(app);

    const res = await app.inject({ method: "POST", url: "/partner/login", payload: SIGNUP_BODY });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === PARTNER_SESSION_COOKIE)).toBeTruthy();

    await app.close();
  });

  it("rejects the wrong password", async () => {
    const app = await buildApp();
    await signup(app);

    const res = await app.inject({
      method: "POST",
      url: "/partner/login",
      payload: { email: SIGNUP_BODY.email, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("rejects an unknown email with the same message as a wrong password (no enumeration)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/partner/login",
      payload: { email: "nobody@partner-co.example", password: "whatever123" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Invalid email or password");

    await app.close();
  });
});

describe("partner session", () => {
  it("rejects every /partner/* route with no session cookie", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/partner/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("does not accept a real per-customer x-api-key as a session", async () => {
    const { plaintext } = await createApiKey(pool, "someone@example.com", "growth");
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/partner/me", headers: { "x-api-key": plaintext } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /partner/me returns the signed-in partner's profile, never the password hash", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);

    const res = await app.inject({ method: "GET", url: "/partner/me", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().partner).toMatchObject({ email: SIGNUP_BODY.email });
    expect(res.json().partner.passwordHash).toBeUndefined();

    await app.close();
  });
});

describe("partner api keys", () => {
  it("lists only the signed-in partner's own keys, not another partner's or an admin-issued one", async () => {
    const app = await buildApp();
    const { cookies, body } = await signup(app);

    // An admin-issued key sharing the same owner email, but with no
    // partner_id -- must never show up in this partner's list.
    await createApiKey(pool, SIGNUP_BODY.email, "growth");
    // A second partner's own key -- must never show up either.
    await signup(app, { email: "other@partner-co.example", password: "correct-horse-battery" });

    const res = await app.inject({ method: "GET", url: "/partner/api-keys", cookies });
    expect(res.statusCode).toBe(200);
    const apiKeys = res.json().apiKeys as Array<{ id: string }>;
    expect(apiKeys).toHaveLength(1);
    expect(apiKeys[0]?.id).toBe(body.apiKey.id);

    await app.close();
  });

  it("creates an additional free-tier key, and enforces the active-key cap", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);

    // Signup already issued key #1. Create up to the cap.
    for (let i = 1; i < PARTNER_MAX_ACTIVE_KEYS; i++) {
      const res = await app.inject({ method: "POST", url: "/partner/api-keys", cookies });
      expect(res.statusCode).toBe(201);
      expect(res.json().apiKey.tier).toBe("free");
    }

    const overCap = await app.inject({ method: "POST", url: "/partner/api-keys", cookies });
    expect(overCap.statusCode).toBe(400);
    expect(overCap.json().message).toMatch(/active keys/i);

    await app.close();
  });

  it("rotates its own key", async () => {
    const app = await buildApp();
    const { cookies, body } = await signup(app);

    const res = await app.inject({
      method: "POST",
      url: `/partner/api-keys/${body.apiKey.id}/rotate`,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().apiKey.id).not.toBe(body.apiKey.id);
    expect(res.json().apiKey.partnerId).toBe(body.partner.id);
    expect(typeof res.json().plaintext).toBe("string");

    await app.close();
  });

  it("revokes its own key, idempotently rejecting a second revoke", async () => {
    const app = await buildApp();
    const { cookies, body } = await signup(app);

    const first = await app.inject({
      method: "POST",
      url: `/partner/api-keys/${body.apiKey.id}/revoke`,
      cookies,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/partner/api-keys/${body.apiKey.id}/revoke`,
      cookies,
    });
    expect(second.statusCode).toBe(404);

    await app.close();
  });

  it("404s (not 403) rotating/revoking another partner's key -- ownership isn't leaked", async () => {
    const app = await buildApp();
    const mine = await signup(app);
    const theirs = await signup(app, { email: "other@partner-co.example", password: "correct-horse-battery" });

    const rotate = await app.inject({
      method: "POST",
      url: `/partner/api-keys/${theirs.body.apiKey.id}/rotate`,
      cookies: mine.cookies,
    });
    expect(rotate.statusCode).toBe(404);

    const revoke = await app.inject({
      method: "POST",
      url: `/partner/api-keys/${theirs.body.apiKey.id}/revoke`,
      cookies: mine.cookies,
    });
    expect(revoke.statusCode).toBe(404);

    await app.close();
  });

  it("404s on a malformed key id instead of 500ing", async () => {
    const app = await buildApp();
    const { cookies } = await signup(app);

    const res = await app.inject({ method: "POST", url: "/partner/api-keys/not-a-uuid/revoke", cookies });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe("partner usage and logs", () => {
  it("reports the free tier's hourly/monthly limits and reflects real request counts", async () => {
    const app = await buildApp();
    const { cookies, body } = await signup(app);

    // Two real authenticated calls against the freshly issued key.
    await app.inject({ method: "GET", url: "/wallet/abc/pnl?chain=solana", headers: { "x-api-key": body.plaintext } });
    await app.inject({ method: "GET", url: "/wallet/abc/pnl?chain=solana", headers: { "x-api-key": body.plaintext } });

    const res = await app.inject({ method: "GET", url: "/partner/usage", cookies });
    expect(res.statusCode).toBe(200);
    const usage = res.json();
    expect(usage.keys).toHaveLength(1);
    expect(usage.keys[0]).toMatchObject({ id: body.apiKey.id, tier: "free" });
    expect(usage.keys[0].hourlyLimit).toEqual(expect.any(Number));
    expect(usage.keys[0].monthlyLimit).toBe(50_000);
    expect(usage.keys[0].requestsLastHour).toBeGreaterThanOrEqual(2);
    expect(usage.totalRequestsLastHour).toBeGreaterThanOrEqual(2);

    await app.close();
  });

  it("lists recent request-log entries for the partner's own key(s)", async () => {
    const app = await buildApp();
    const { cookies, body } = await signup(app);

    await app.inject({ method: "GET", url: "/wallet/xyz/pnl?chain=solana", headers: { "x-api-key": body.plaintext } });

    const res = await app.inject({ method: "GET", url: "/partner/logs", cookies });
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries as Array<{ method: string; path: string; statusCode: number }>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]).toMatchObject({ method: "GET", path: "/wallet/xyz/pnl", statusCode: 200 });

    await app.close();
  });

  it("never includes another partner's requests in the log", async () => {
    const app = await buildApp();
    const mine = await signup(app);
    const theirs = await signup(app, { email: "other@partner-co.example", password: "correct-horse-battery" });

    await app.inject({
      method: "GET",
      url: "/wallet/theirs/pnl?chain=solana",
      headers: { "x-api-key": theirs.body.plaintext },
    });

    const res = await app.inject({ method: "GET", url: "/partner/logs", cookies: mine.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(0);

    await app.close();
  });
});
