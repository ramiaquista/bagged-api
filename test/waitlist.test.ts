import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db/pool.js";

// Real integration tests against Postgres (see db/schema.sql's `waitlist`
// table and src/db/waitlist.ts) rather than mocks, matching how the rest of
// this suite tests through app.inject() against a real Fastify instance.
// Requires a reachable Postgres matching DATABASE_URL -- `docker compose up
// -d` locally (see docker-compose.yml / README).
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table waitlist");
});

afterAll(async () => {
  await pool.end();
});

describe("waitlist", () => {
  it("accepts a signup without an x-api-key header", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "trader@example.com" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("is idempotent for a repeat signup", async () => {
    const app = await buildApp();
    const payload = { email: "repeat@example.com" };

    const first = await app.inject({ method: "POST", url: "/waitlist", payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: "POST", url: "/waitlist", payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "already_registered" });

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
