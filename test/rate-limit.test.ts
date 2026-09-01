import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createApiKey, revokeApiKey } from "../src/db/apiKeys.js";
import { createPool } from "../src/db/pool.js";
import { hourlyRequestLimit } from "../src/lib/tiers.js";

// Integration tests for src/plugins/rateLimit.ts (NEXT_STEPS.md Item 7),
// layered on top of test/api-key-auth.test.ts. Requires a reachable
// Postgres matching DATABASE_URL, same as the other db-backed suites.
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table api_key_usage, api_keys cascade");
});

afterAll(async () => {
  await pool.end();
});

describe("per-tier rate limiting", () => {
  it("gives different tiers different x-ratelimit-limit values, matching hourlyRequestLimit", async () => {
    const free = await createApiKey(pool, "free-owner@example.com", "free");
    const builder = await createApiKey(pool, "builder-owner@example.com", "builder");
    const growth = await createApiKey(pool, "growth-owner@example.com", "growth");

    const app = await buildApp();

    for (const { plaintext, tier } of [
      { plaintext: free.plaintext, tier: "free" as const },
      { plaintext: builder.plaintext, tier: "builder" as const },
      { plaintext: growth.plaintext, tier: "growth" as const },
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/wallet/abc/pnl?chain=solana",
        headers: { "x-api-key": plaintext },
      });
      expect(res.statusCode).toBe(200);
      expect(Number(res.headers["x-ratelimit-limit"])).toBe(hourlyRequestLimit(tier));
    }

    // The three placeholder tiers are meant to be strictly increasing.
    expect(hourlyRequestLimit("free")).toBeLessThan(hourlyRequestLimit("builder"));
    expect(hourlyRequestLimit("builder")).toBeLessThan(hourlyRequestLimit("growth"));

    await app.close();
  });

  it("returns 429 with rate-limit headers once a tiered key exceeds its hourly limit", async () => {
    const { plaintext } = await createApiKey(pool, "owner@example.com", "free");
    const limit = hourlyRequestLimit("free");
    const app = await buildApp();

    let lastRes;
    for (let i = 0; i < limit; i += 1) {
      lastRes = await app.inject({
        method: "GET",
        url: "/wallet/abc/pnl?chain=solana",
        headers: { "x-api-key": plaintext },
      });
      expect(lastRes.statusCode).toBe(200);
    }

    // One more request than the limit allows.
    const blocked = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": plaintext },
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: "rate_limited" });
    expect(blocked.json().message).toEqual(expect.any(String));
    expect(Number(blocked.headers["x-ratelimit-limit"])).toBe(limit);
    expect(Number(blocked.headers["x-ratelimit-remaining"])).toBe(0);
    expect(blocked.headers["retry-after"]).toBeDefined();

    await app.close();
  });

  it("does not let one key's usage count against a different key on the same tier", async () => {
    const a = await createApiKey(pool, "a@example.com", "free");
    const b = await createApiKey(pool, "b@example.com", "free");
    const limit = hourlyRequestLimit("free");
    const app = await buildApp();

    // Exhaust key A's limit.
    for (let i = 0; i < limit; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/wallet/abc/pnl?chain=solana",
        headers: { "x-api-key": a.plaintext },
      });
      expect(res.statusCode).toBe(200);
    }
    const aBlocked = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": a.plaintext },
    });
    expect(aBlocked.statusCode).toBe(429);

    // Key B, same tier, is unaffected.
    const bOk = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": b.plaintext },
    });
    expect(bOk.statusCode).toBe(200);

    await app.close();
  });
});

describe("legacy shared-secret / dev-key path is not newly rate-limited more strictly", () => {
  it("keeps the pre-existing global default (100 req/min) for the shared secret", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": config.API_KEY_SECRET },
    });

    expect(res.statusCode).toBe(200);
    expect(Number(res.headers["x-ratelimit-limit"])).toBe(100);

    await app.close();
  });

  it("keeps the pre-existing global default (100 req/min) for the dev bypass key", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": "dev" },
    });

    expect(res.statusCode).toBe(200);
    expect(Number(res.headers["x-ratelimit-limit"])).toBe(100);

    await app.close();
  });

  it("does not apply a tier-based limit to an enterprise key (no fixed TIER_LIMITS entry)", async () => {
    const { plaintext } = await createApiKey(pool, "enterprise-owner@example.com", "enterprise");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": plaintext },
    });

    expect(res.statusCode).toBe(200);
    expect(Number(res.headers["x-ratelimit-limit"])).toBe(100);

    await app.close();
  });
});

describe("invalid/revoked keys are unaffected by rate limiting", () => {
  it("still returns 401 (not 429) for a revoked key, even with headers unset by the limiter", async () => {
    const { record, plaintext } = await createApiKey(pool, "owner@example.com", "free");
    await revokeApiKey(pool, record.id);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": plaintext },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
    // The apiKey plugin's onRequest hook rejected the request before the
    // rate-limit preHandler hook ever ran, so no rate-limit headers exist.
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();

    await app.close();
  });

  it("still returns 401 (not 429) for a key that was never issued", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": "bg_totally-made-up" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();

    await app.close();
  });

  it("still returns 401 (not 429) when no x-api-key header is sent at all", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/wallet/abc/pnl?chain=solana" });

    expect(res.statusCode).toBe(401);
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();

    await app.close();
  });
});
