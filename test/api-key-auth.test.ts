import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createApiKey, getUsageCount, revokeApiKey, usageWindowStart } from "../src/db/apiKeys.js";
import { createPool } from "../src/db/pool.js";

// Integration tests for src/plugins/apiKey.ts's real per-customer auth path,
// layered on top of test/auth.test.ts (which covers the basic dev-key
// smoke test) and test/dev-key-gate.test.ts (the ALLOW_DEV_KEY gate).
// Requires a reachable Postgres matching DATABASE_URL, same as
// test/waitlist.test.ts / test/db-api-keys.test.ts.
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table api_key_usage, api_keys cascade");
});

afterAll(async () => {
  await pool.end();
});

/**
 * Registers a throwaway introspection route on an already-built app so
 * tests can observe what src/plugins/apiKey.ts attached to `req.apiKey`,
 * without adding a permanent (and unnecessary) route to the real API
 * surface just for testing. Safe to call before the first `app.inject()`
 * -- Fastify only rejects new routes once the instance has been booted.
 */
function withApiKeyEcho(app: Awaited<ReturnType<typeof buildApp>>) {
  app.get("/__test/api-key-context", async (req) => ({ apiKey: req.apiKey ?? null }));
}

describe("real per-customer API key auth", () => {
  it("accepts a freshly issued key and reports its tier/owner", async () => {
    const { plaintext } = await createApiKey(pool, "owner@example.com", "growth");
    const app = await buildApp();
    withApiKeyEcho(app);

    const res = await app.inject({
      method: "GET",
      url: "/__test/api-key-context",
      headers: { "x-api-key": plaintext },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().apiKey).toMatchObject({
      tier: "growth",
      ownerEmail: "owner@example.com",
      legacy: false,
    });
    expect(res.json().apiKey.id).toEqual(expect.any(String));

    await app.close();
  });

  it("rejects an invalid/unknown key", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": "bg_not-a-real-key" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a revoked key", async () => {
    const { record, plaintext } = await createApiKey(pool, "owner@example.com", "free");
    await revokeApiKey(pool, record.id);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": plaintext },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("differentiates tiers across keys for the same request shape", async () => {
    const free = await createApiKey(pool, "free-owner@example.com", "free");
    const builder = await createApiKey(pool, "builder-owner@example.com", "builder");
    const growth = await createApiKey(pool, "growth-owner@example.com", "growth");

    const app = await buildApp();
    withApiKeyEcho(app);

    for (const { plaintext, tier } of [
      { plaintext: free.plaintext, tier: "free" },
      { plaintext: builder.plaintext, tier: "builder" },
      { plaintext: growth.plaintext, tier: "growth" },
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/__test/api-key-context",
        headers: { "x-api-key": plaintext },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().apiKey.tier).toBe(tier);
    }

    await app.close();
  });

  it("increments the per-key usage counter on each authenticated request", async () => {
    const { record, plaintext } = await createApiKey(pool, "owner@example.com", "builder");
    const app = await buildApp();

    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/wallet/abc/pnl?chain=solana",
        headers: { "x-api-key": plaintext },
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();

    const count = await getUsageCount(pool, record.id, usageWindowStart());
    expect(count).toBe(3);

    const row = await pool.query("select last_used_at from api_keys where id = $1", [record.id]);
    expect(row.rows[0].last_used_at).not.toBeNull();
  });

  it("does not increment usage for a rejected (revoked) key", async () => {
    const { record, plaintext } = await createApiKey(pool, "owner@example.com", "free");
    await revokeApiKey(pool, record.id);

    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": plaintext },
    });
    await app.close();

    const count = await getUsageCount(pool, record.id, usageWindowStart());
    expect(count).toBe(0);
  });

  it("does not require distinct keys to interfere with each other's usage counts", async () => {
    const a = await createApiKey(pool, "a@example.com", "free");
    const b = await createApiKey(pool, "b@example.com", "free");
    const app = await buildApp();

    await app.inject({ method: "GET", url: "/wallet/abc/pnl?chain=solana", headers: { "x-api-key": a.plaintext } });
    await app.inject({ method: "GET", url: "/wallet/abc/pnl?chain=solana", headers: { "x-api-key": a.plaintext } });
    await app.inject({ method: "GET", url: "/wallet/abc/pnl?chain=solana", headers: { "x-api-key": b.plaintext } });
    await app.close();

    expect(await getUsageCount(pool, a.record.id, usageWindowStart())).toBe(2);
    expect(await getUsageCount(pool, b.record.id, usageWindowStart())).toBe(1);
  });
});

describe("legacy shared-secret / dev-key auth (backward compatibility)", () => {
  it("still accepts the shared API_KEY_SECRET and tags it as legacy/internal", async () => {
    const app = await buildApp();
    withApiKeyEcho(app);

    const res = await app.inject({
      method: "GET",
      url: "/__test/api-key-context",
      headers: { "x-api-key": config.API_KEY_SECRET },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().apiKey).toEqual({ id: null, tier: "internal", ownerEmail: null, legacy: true });

    await app.close();
  });

  it("still accepts the local 'dev' bypass key and tags it as legacy/internal", async () => {
    const app = await buildApp();
    withApiKeyEcho(app);

    const res = await app.inject({
      method: "GET",
      url: "/__test/api-key-context",
      headers: { "x-api-key": "dev" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().apiKey).toEqual({ id: null, tier: "internal", ownerEmail: null, legacy: true });

    await app.close();
  });

  it("does not write usage counters for legacy/dev-key requests", async () => {
    const app = await buildApp();
    const before = await pool.query("select count(*)::text as n from api_key_usage");

    await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": "dev" },
    });
    await app.close();

    const after = await pool.query("select count(*)::text as n from api_key_usage");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
