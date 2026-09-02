import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db/pool.js";
import { hourlyRequestLimit } from "../src/lib/tiers.js";
import { resetWaitlistKeySlotsForTests } from "../src/lib/waitlistAbuseGuard.js";

// Real integration tests against Postgres (see db/schema.sql's `waitlist`
// table and src/db/waitlist.ts) rather than mocks, matching how the rest of
// this suite tests through app.inject() against a real Fastify instance.
// Requires a reachable Postgres matching DATABASE_URL -- `docker compose up
// -d` locally (see docker-compose.yml / README).
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table waitlist");
  // api_keys/api_key_usage too: this suite now mints real keys on every
  // fresh signup (Part 1 -- see src/routes/waitlist.ts), and several tests
  // below assert exact per-email row counts there.
  await pool.query("truncate table api_key_usage, api_keys cascade");
  // Per-IP daily key-issuance counters (src/lib/waitlistAbuseGuard.ts) are
  // in-memory/module-level, not reset by truncating tables -- and every
  // test in this file signs up from the same default app.inject() IP, so
  // without this reset, later tests would eventually trip the daily cap
  // that's meant to guard against real abuse, not normal test traffic.
  resetWaitlistKeySlotsForTests();
});

afterAll(async () => {
  await pool.end();
});

describe("waitlist", () => {
  it("accepts a signup without an x-api-key header and issues a free-tier api key", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "trader@example.com" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.api_key).toMatch(/^bg_[0-9a-f]{48}$/);

    const rows = await pool.query("select tier, owner_email from api_keys where owner_email = $1", [
      "trader@example.com",
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({ tier: "free", owner_email: "trader@example.com" });

    await app.close();
  });

  it("is idempotent for a repeat signup, and does not mint a second key", async () => {
    const app = await buildApp();
    const payload = { email: "repeat@example.com" };

    const first = await app.inject({ method: "POST", url: "/waitlist", payload });
    expect(first.statusCode).toBe(201);
    const firstKey = first.json().api_key;
    expect(firstKey).toMatch(/^bg_[0-9a-f]{48}$/);

    const second = await app.inject({ method: "POST", url: "/waitlist", payload });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody).toEqual({ status: "already_registered" });
    expect(secondBody.api_key).toBeUndefined();

    const rows = await pool.query("select count(*)::int as count from api_keys where owner_email = $1", [
      "repeat@example.com",
    ]);
    expect(rows.rows[0].count).toBe(1);

    await app.close();
  });

  it("applies the free tier's hourly rate limit to a key issued via signup", async () => {
    const app = await buildApp();

    const signup = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "fresh-free-tier@example.com" },
    });
    expect(signup.statusCode).toBe(201);
    const apiKey = signup.json().api_key;

    // NEXT_STEPS.md's "explicitly out of scope" note says the existing
    // tiered rate limiter (src/plugins/rateLimit.ts) should just apply to
    // any freshly-issued free-tier key automatically -- verified here
    // rather than assumed.
    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(Number(res.headers["x-ratelimit-limit"])).toBe(hourlyRequestLimit("free"));

    await app.close();
  });

  it("normalizes case before dedup", async () => {
    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "Mixed@Example.com" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "mixed@example.com" },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "already_registered" });

    await app.close();
  });

  it("rejects an invalid email", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "not-an-email" },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("keeps /waitlist/count behind the standard x-api-key check", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/waitlist/count" });
    expect(res.statusCode).toBe(401);

    const withKey = await app.inject({
      method: "GET",
      url: "/waitlist/count",
      headers: { "x-api-key": "dev" },
    });
    expect(withKey.statusCode).toBe(200);
    expect(withKey.json()).toEqual({ count: expect.any(Number) });

    await app.close();
  });

  it("requires x-api-key for GET /waitlist and returns real entries", async () => {
    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "alice@example.com", note: "building a bot" },
    });
    await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "bob@example.com" },
    });

    const unauthed = await app.inject({ method: "GET", url: "/waitlist" });
    expect(unauthed.statusCode).toBe(401);

    const res = await app.inject({
      method: "GET",
      url: "/waitlist",
      headers: { "x-api-key": "dev" },
    });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: "alice@example.com", note: "building a bot" }),
        expect.objectContaining({ email: "bob@example.com" }),
      ]),
    );
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(() => new Date(entry.created_at).toISOString()).not.toThrow();
    }

    await app.close();
  });

  it("persists signups across a restart (new app instance, new pool)", async () => {
    const firstApp = await buildApp();
    const create = await firstApp.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "durable@example.com" },
    });
    expect(create.statusCode).toBe(201);
    // Simulates a process restart: closing the app tears down its
    // connection pool entirely (see src/plugins/db.ts's onClose hook), so
    // reading the signup back via a brand-new app/pool proves it's really
    // in Postgres, not just an in-memory Map that happened to survive.
    await firstApp.close();

    const secondApp = await buildApp();
    const res = await secondApp.inject({
      method: "GET",
      url: "/waitlist",
      headers: { "x-api-key": "dev" },
    });
    expect(res.json().entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: "durable@example.com" })]),
    );

    await secondApp.close();
  });
});
