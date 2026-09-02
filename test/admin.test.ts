import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createApiKey } from "../src/db/apiKeys.js";
import { createPool } from "../src/db/pool.js";
import { registerWebhook } from "../src/db/webhooks.js";

// Real integration tests against Postgres, matching test/waitlist.test.ts's
// and test/webhooks.test.ts's pattern. Truncates the same table set as
// test/db-api-keys.test.ts/test/api-key-auth.test.ts/test/rate-limit.test.ts
// (api_key_usage, api_keys) plus waitlist and wallets (which cascades to
// webhooks) -- safe because vitest.config.ts turns off file parallelism, so
// these files never run concurrently against the shared DB.
const pool = createPool();

const internalHeaders = { "x-api-key": "dev" };

beforeEach(async () => {
  await pool.query("truncate table api_key_usage, api_keys cascade");
  await pool.query("truncate table waitlist");
  await pool.query("truncate table wallets cascade");
});

afterAll(async () => {
  await pool.end();
});

describe("admin routes", () => {
  it("reject requests with no x-api-key", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/admin/overview" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("reject a real per-customer key regardless of tier", async () => {
    const app = await buildApp();
    const { plaintext } = await createApiKey(pool, "customer@example.com", "growth");

    const res = await app.inject({
      method: "GET",
      url: "/admin/overview",
      headers: { "x-api-key": plaintext },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it("accept the legacy shared-secret/dev key", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/admin/overview", headers: internalHeaders });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("GET /admin/overview reflects real counts across api keys, waitlist, and webhooks", async () => {
    const app = await buildApp();

    await createApiKey(pool, "one@example.com", "free");
    const { record: revokedKey } = await createApiKey(pool, "two@example.com", "builder");
    await app.inject({
      method: "POST",
      url: `/admin/api-keys/${revokedKey.id}/revoke`,
      headers: internalHeaders,
    });

    await app.inject({ method: "POST", url: "/waitlist", payload: { email: "waiter@example.com" } });

    await registerWebhook(pool, { chain: "solana", wallet: "wallet-a", url: "https://example.com/hook", threshold_pct: 5 });

    const res = await app.inject({ method: "GET", url: "/admin/overview", headers: internalHeaders });
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
    await createApiKey(pool, "alice@example.com", "free");
    await createApiKey(pool, "bob@example.com", "builder");

    const all = await app.inject({ method: "GET", url: "/admin/api-keys", headers: internalHeaders });
    expect(all.json().apiKeys).toHaveLength(2);

    const filtered = await app.inject({
      method: "GET",
      url: "/admin/api-keys?email=alice@example.com",
      headers: internalHeaders,
    });
    expect(filtered.json().apiKeys).toHaveLength(1);
    expect(filtered.json().apiKeys[0]).toMatchObject({ ownerEmail: "alice@example.com" });

    await app.close();
  });

  it("POST /admin/api-keys issues a new key and returns the plaintext once", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/admin/api-keys",
      headers: internalHeaders,
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
    const res = await app.inject({
      method: "POST",
      url: "/admin/api-keys",
      headers: internalHeaders,
      payload: { email: "partner@example.com", tier: "enterprise" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /admin/api-keys/:id/rotate revokes the old key and issues a new one", async () => {
    const app = await buildApp();
    const { record } = await createApiKey(pool, "rotate-me@example.com", "free");

    const res = await app.inject({
      method: "POST",
      url: `/admin/api-keys/${record.id}/rotate`,
      headers: internalHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.apiKey.id).not.toBe(record.id);
    expect(body.apiKey.ownerEmail).toBe("rotate-me@example.com");
    expect(typeof body.plaintext).toBe("string");

    const list = await app.inject({ method: "GET", url: "/admin/api-keys", headers: internalHeaders });
    const old = list.json().apiKeys.find((k: { id: string }) => k.id === record.id);
    expect(old.revokedAt).not.toBeNull();

    await app.close();
  });

  it("POST /admin/api-keys/:id/revoke is idempotent and 404s the second time", async () => {
    const app = await buildApp();
    const { record } = await createApiKey(pool, "revoke-me@example.com", "free");

    const first = await app.inject({
      method: "POST",
      url: `/admin/api-keys/${record.id}/revoke`,
      headers: internalHeaders,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ revoked: true });

    const second = await app.inject({
      method: "POST",
      url: `/admin/api-keys/${record.id}/revoke`,
      headers: internalHeaders,
    });
    expect(second.statusCode).toBe(404);

    await app.close();
  });

  it("404s on a malformed or unknown api key id instead of 500ing", async () => {
    const app = await buildApp();

    const malformed = await app.inject({
      method: "POST",
      url: "/admin/api-keys/not-a-uuid/revoke",
      headers: internalHeaders,
    });
    expect(malformed.statusCode).toBe(404);

    const unknown = await app.inject({
      method: "POST",
      url: "/admin/api-keys/00000000-0000-0000-0000-000000000000/rotate",
      headers: internalHeaders,
    });
    expect(unknown.statusCode).toBe(404);

    await app.close();
  });

  it("GET /admin/webhooks and GET /admin/waitlist return real data", async () => {
    const app = await buildApp();
    await registerWebhook(pool, { chain: "solana", wallet: "wallet-b", url: "https://example.com/hook", threshold_pct: 10 });
    await app.inject({ method: "POST", url: "/waitlist", payload: { email: "seen@example.com" } });

    const webhooks = await app.inject({ method: "GET", url: "/admin/webhooks", headers: internalHeaders });
    expect(webhooks.json().webhooks).toHaveLength(1);

    const waitlist = await app.inject({ method: "GET", url: "/admin/waitlist", headers: internalHeaders });
    expect(waitlist.json().entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: "seen@example.com" })]),
    );

    await app.close();
  });
});
