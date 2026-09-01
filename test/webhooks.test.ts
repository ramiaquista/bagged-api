import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db/pool.js";
import { getLatestPnlSnapshot, insertPnlSnapshot } from "../src/db/pnlSnapshots.js";
import { findOrCreateWallet } from "../src/db/wallets.js";
import { deleteWebhook, listWebhooks, listWebhooksForDelivery, registerWebhook } from "../src/db/webhooks.js";
import type { WalletPnl } from "../src/schemas/pnl.js";
import type { RegisterWebhookRequest } from "../src/schemas/webhook.js";
import type { GetProviderFn } from "../src/worker/webhookWorker.js";
import { runWebhookCheckCycle } from "../src/worker/webhookWorker.js";

const headers = { "x-api-key": "dev" };

// Real integration tests against Postgres (see db/schema.sql's `wallets`,
// `webhooks`, and `pnl_snapshots` tables), matching the pattern in
// test/waitlist.test.ts and test/db-api-keys.test.ts. All three tables are
// exercised together in this one file -- rather than split across several
// files -- specifically so a single `beforeEach` truncate can own them
// without racing a different test file's truncate of the same tables (see
// how test/waitlist.test.ts and test/db-api-keys.test.ts each truncate a
// disjoint set of tables so they're safe to run in parallel).
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table wallets cascade");
});

afterAll(async () => {
  await pool.end();
});

function makePnl(overrides: Partial<WalletPnl> & Pick<WalletPnl, "wallet" | "chain">): WalletPnl {
  const realized = overrides.realized_pnl_usd ?? 0;
  const unrealized = overrides.unrealized_pnl_usd ?? 0;
  return {
    realized_pnl_usd: realized,
    unrealized_pnl_usd: unrealized,
    total_pnl_usd: overrides.total_pnl_usd ?? realized + unrealized,
    positions_open: overrides.positions_open ?? 1,
    wash_trades_excluded: overrides.wash_trades_excluded ?? 0,
    rugs_resolved: overrides.rugs_resolved ?? 0,
    as_of: overrides.as_of ?? new Date().toISOString(),
    ...overrides,
  };
}

/** A fake chain provider, keyed by wallet address, for worker tests that must never hit a real provider/network. */
function fakeProvider(pnlByAddress: Record<string, WalletPnl>): GetProviderFn {
  return () => ({
    getWalletPnl: async (address: string) => {
      const pnl = pnlByAddress[address];
      if (!pnl) throw new Error(`no fake PnL configured for address ${address}`);
      return pnl;
    },
  });
}

describe("db/wallets", () => {
  it("creates a wallet row on first sight", async () => {
    const wallet = await findOrCreateWallet(pool, "solana", "wallet-a");
    expect(wallet.chain).toBe("solana");
    expect(wallet.address).toBe("wallet-a");

    const rows = await pool.query("select count(*)::int as count from wallets");
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("returns the same row for the same (chain, address) pair instead of duplicating it", async () => {
    const first = await findOrCreateWallet(pool, "solana", "wallet-a");
    const second = await findOrCreateWallet(pool, "solana", "wallet-a");
    expect(second.id).toBe(first.id);

    const rows = await pool.query("select count(*)::int as count from wallets");
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("treats the same address on a different chain as a different wallet", async () => {
    const solana = await findOrCreateWallet(pool, "solana", "same-address");
    const bnb = await findOrCreateWallet(pool, "bnb", "same-address");
    expect(solana.id).not.toBe(bnb.id);
  });
});

describe("db/webhooks", () => {
  const input: RegisterWebhookRequest = {
    url: "https://example.com/hook",
    wallet: "wallet-a",
    chain: "solana",
    threshold_pct: 15,
  };

  it("registers a webhook and resolves the wallet id behind the scenes", async () => {
    const record = await registerWebhook(pool, input);

    expect(record.url).toBe(input.url);
    expect(record.wallet).toBe(input.wallet);
    expect(record.chain).toBe(input.chain);
    expect(record.threshold_pct).toBe(15);
    expect(() => new Date(record.created_at).toISOString()).not.toThrow();

    const walletRows = await pool.query("select count(*)::int as count from wallets");
    expect(walletRows.rows[0]?.count).toBe(1);
  });

  it("does not create a second wallet row when registering a second webhook for the same wallet", async () => {
    await registerWebhook(pool, input);
    await registerWebhook(pool, { ...input, url: "https://example.com/other-hook", threshold_pct: 5 });

    const walletRows = await pool.query("select count(*)::int as count from wallets");
    expect(walletRows.rows[0]?.count).toBe(1);

    const webhooks = await listWebhooks(pool);
    expect(webhooks).toHaveLength(2);
  });

  it("lists webhooks ordered by creation time", async () => {
    const first = await registerWebhook(pool, input);
    const second = await registerWebhook(pool, { ...input, wallet: "wallet-b" });

    const listed = await listWebhooks(pool);
    expect(listed.map((w) => w.id)).toEqual([first.id, second.id]);
  });

  it("deletes a webhook and is idempotent for a repeat delete", async () => {
    const record = await registerWebhook(pool, input);

    expect(await deleteWebhook(pool, record.id)).toBe(true);
    expect(await deleteWebhook(pool, record.id)).toBe(false);
    expect(await listWebhooks(pool)).toHaveLength(0);
  });

  it("listWebhooksForDelivery includes the internal wallet id the worker needs", async () => {
    const record = await registerWebhook(pool, input);
    const targets = await listWebhooksForDelivery(pool);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: record.id,
      url: record.url,
      thresholdPct: record.threshold_pct,
      chain: record.chain,
      address: record.wallet,
    });
    expect(targets[0]?.walletId).toEqual(expect.any(String));
  });
});

describe("db/pnlSnapshots", () => {
  it("returns null when a wallet has never been checked", async () => {
    const wallet = await findOrCreateWallet(pool, "solana", "wallet-a");
    expect(await getLatestPnlSnapshot(pool, wallet.id)).toBeNull();
  });

  it("returns the most recently inserted snapshot", async () => {
    const wallet = await findOrCreateWallet(pool, "solana", "wallet-a");
    await insertPnlSnapshot(pool, {
      walletId: wallet.id,
      realizedPnlUsd: 10,
      unrealizedPnlUsd: 5,
      positionsOpen: 1,
      washTradesExcluded: 0,
      rugsResolved: 0,
    });
    const latest = await insertPnlSnapshot(pool, {
      walletId: wallet.id,
      realizedPnlUsd: 20,
      unrealizedPnlUsd: 8,
      positionsOpen: 2,
      washTradesExcluded: 1,
      rugsResolved: 0,
    });

    const found = await getLatestPnlSnapshot(pool, wallet.id);
    expect(found?.id).toBe(latest.id);
    expect(found?.realizedPnlUsd).toBe(20);
    expect(found?.unrealizedPnlUsd).toBe(8);
  });
});

describe("routes/webhooks", () => {
  it("registers and lists a webhook, persisted in Postgres", async () => {
    const app = await buildApp();

    const create = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers,
      payload: { url: "https://example.com/hook", wallet: "abc", chain: "solana" },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created).toMatchObject({ url: "https://example.com/hook", wallet: "abc", chain: "solana", threshold_pct: 10 });

    const list = await app.inject({ method: "GET", url: "/webhooks", headers });
    expect(list.json().webhooks.some((w: { id: string }) => w.id === created.id)).toBe(true);

    await app.close();
  });

  it("persists a registered webhook across a restart (new app instance, new pool)", async () => {
    const firstApp = await buildApp();
    const create = await firstApp.inject({
      method: "POST",
      url: "/webhooks",
      headers,
      payload: { url: "https://example.com/hook", wallet: "durable-wallet", chain: "solana", threshold_pct: 25 },
    });
    const { id } = create.json();
    await firstApp.close();

    const secondApp = await buildApp();
    const list = await secondApp.inject({ method: "GET", url: "/webhooks", headers });
    expect(list.json().webhooks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, wallet: "durable-wallet", threshold_pct: 25 })]),
    );
    await secondApp.close();
  });

  it("deletes a webhook by id, then 404s on a repeat delete", async () => {
    const app = await buildApp();

    const create = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers,
      payload: { url: "https://example.com/hook", wallet: "abc", chain: "solana" },
    });
    const { id } = create.json();

    const del = await app.inject({ method: "DELETE", url: `/webhooks/${id}`, headers });
    expect(del.statusCode).toBe(204);

    const again = await app.inject({ method: "DELETE", url: `/webhooks/${id}`, headers });
    expect(again.statusCode).toBe(404);

    await app.close();
  });

  it("404s (not 500) for a malformed id, since it's a uuid column under the hood", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "DELETE", url: "/webhooks/not-a-uuid", headers });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("requires x-api-key", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      payload: { url: "https://example.com/hook", wallet: "abc", chain: "solana" },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe("worker/webhookWorker: runWebhookCheckCycle", () => {
  it("does nothing when there are no registered webhooks", async () => {
    const app = await buildApp();
    const fetchImpl = vi.fn();

    await runWebhookCheckCycle(app, fakeProvider({}), fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    await app.close();
  });

  it("on the first-ever check, records a baseline snapshot but never delivers", async () => {
    const app = await buildApp();
    const fetchImpl = vi.fn();
    await registerWebhook(pool, { url: "https://example.com/hook", wallet: "wallet-a", chain: "solana", threshold_pct: 5 });

    await runWebhookCheckCycle(
      app,
      fakeProvider({ "wallet-a": makePnl({ wallet: "wallet-a", chain: "solana", realized_pnl_usd: 500 }) }),
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    const wallet = await findOrCreateWallet(pool, "solana", "wallet-a");
    const snapshot = await getLatestPnlSnapshot(pool, wallet.id);
    expect(snapshot?.realizedPnlUsd).toBe(500);

    await app.close();
  });

  it("delivers when a second check crosses the threshold, with the expected payload", async () => {
    const app = await buildApp();
    const record = await registerWebhook(pool, {
      url: "https://example.com/hook",
      wallet: "wallet-a",
      chain: "solana",
      threshold_pct: 10,
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    // First check establishes the baseline ($100 total).
    await runWebhookCheckCycle(
      app,
      fakeProvider({ "wallet-a": makePnl({ wallet: "wallet-a", chain: "solana", realized_pnl_usd: 100, unrealized_pnl_usd: 0 }) }),
      fetchImpl,
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    // Second check: PnL swings from $100 to $150, a 50% change -- well past the 10% threshold.
    await runWebhookCheckCycle(
      app,
      fakeProvider({ "wallet-a": makePnl({ wallet: "wallet-a", chain: "solana", realized_pnl_usd: 150, unrealized_pnl_usd: 0 }) }),
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      webhook_id: record.id,
      wallet: "wallet-a",
      chain: "solana",
      threshold_pct: 10,
      previous_total_pnl_usd: 100,
      current_total_pnl_usd: 150,
    });
    expect(body.change_pct).toBeCloseTo(50);

    await app.close();
  });

  it("does not deliver when the change stays under the threshold", async () => {
    const app = await buildApp();
    await registerWebhook(pool, { url: "https://example.com/hook", wallet: "wallet-a", chain: "solana", threshold_pct: 50 });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await runWebhookCheckCycle(
      app,
      fakeProvider({ "wallet-a": makePnl({ wallet: "wallet-a", chain: "solana", realized_pnl_usd: 100 }) }),
      fetchImpl,
    );
    await runWebhookCheckCycle(
      app,
      // +10%, under the 50% threshold.
      fakeProvider({ "wallet-a": makePnl({ wallet: "wallet-a", chain: "solana", realized_pnl_usd: 110 }) }),
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    await app.close();
  });

  it("only delivers to the webhooks on a wallet whose own threshold is crossed", async () => {
    const app = await buildApp();
    const tight = await registerWebhook(pool, { url: "https://example.com/tight", wallet: "wallet-a", chain: "solana", threshold_pct: 5 });
    const loose = await registerWebhook(pool, { url: "https://example.com/loose", wallet: "wallet-a", chain: "solana", threshold_pct: 90 });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await runWebhookCheckCycle(app, fakeProvider({ "wallet-a": makePnl({ wallet: "wallet-a", chain: "solana", realized_pnl_usd: 100 }) }), fetchImpl);
    // +20%: crosses the 5% threshold, not the 90% one.
    await runWebhookCheckCycle(app, fakeProvider({ "wallet-a": makePnl({ wallet: "wallet-a", chain: "solana", realized_pnl_usd: 120 }) }), fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(tight.url);
    expect(url).not.toBe(loose.url);

    await app.close();
  });

  it("retries a failing delivery per the configured retry policy", async () => {
    const app = await buildApp();
    await registerWebhook(pool, { url: "https://example.com/hook", wallet: "wallet-a", chain: "solana", threshold_pct: 10 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await runWebhookCheckCycle(app, fakeProvider({ "wallet-a": makePnl({ wallet: "wallet-a", chain: "solana", realized_pnl_usd: 100 }) }), fetchImpl);
    await runWebhookCheckCycle(app, fakeProvider({ "wallet-a": makePnl({ wallet: "wallet-a", chain: "solana", realized_pnl_usd: 200 }) }), fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await app.close();
  }, 10_000);

  it("logs and skips a wallet whose provider call fails, without throwing", async () => {
    const app = await buildApp();
    await registerWebhook(pool, { url: "https://example.com/hook", wallet: "wallet-a", chain: "solana", threshold_pct: 10 });
    const fetchImpl = vi.fn();
    const throwingProvider: GetProviderFn = () => ({
      getWalletPnl: async () => {
        throw new Error("upstream provider exploded");
      },
    });

    await expect(runWebhookCheckCycle(app, throwingProvider, fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();

    const wallet = await findOrCreateWallet(pool, "solana", "wallet-a");
    expect(await getLatestPnlSnapshot(pool, wallet.id)).toBeNull();

    await app.close();
  });

  it("checks each distinct wallet exactly once per cycle even with multiple webhooks on it", async () => {
    const app = await buildApp();
    await registerWebhook(pool, { url: "https://example.com/a", wallet: "wallet-a", chain: "solana", threshold_pct: 5 });
    await registerWebhook(pool, { url: "https://example.com/b", wallet: "wallet-a", chain: "solana", threshold_pct: 5 });
    let calls = 0;
    const countingProvider: GetProviderFn = () => ({
      getWalletPnl: async (address: string) => {
        calls += 1;
        return makePnl({ wallet: address, chain: "solana", realized_pnl_usd: 100 });
      },
    });

    await runWebhookCheckCycle(app, countingProvider, vi.fn());

    expect(calls).toBe(1);
    await app.close();
  });
});

describe("worker/webhookWorker: startWebhookWorker lifecycle", () => {
  it("stop() clears the timer and is safe to call more than once", async () => {
    const { startWebhookWorker } = await import("../src/worker/webhookWorker.js");
    const app = await buildApp();

    const worker = startWebhookWorker(app, { intervalMs: 60_000, getProviderImpl: fakeProvider({}), fetchImpl: vi.fn() });
    expect(() => worker.stop()).not.toThrow();
    expect(() => worker.stop()).not.toThrow();

    await app.close();
  });

  it("runOnce() skips a tick that overlaps a still-running previous one", async () => {
    const { startWebhookWorker } = await import("../src/worker/webhookWorker.js");
    const app = await buildApp();
    await registerWebhook(pool, { url: "https://example.com/hook", wallet: "wallet-a", chain: "solana", threshold_pct: 5 });

    let releaseFirst!: () => void;
    let firstCallStarted!: () => void;
    const firstCallStartedPromise = new Promise<void>((resolve) => {
      firstCallStarted = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;
    const slowProvider: GetProviderFn = () => ({
      getWalletPnl: async (address: string) => {
        callCount += 1;
        if (callCount === 1) {
          // Signal that the first cycle has genuinely started (past its
          // own DB awaits) before the test lets the second `runOnce()`
          // race it -- otherwise both calls could fire back-to-back
          // before either has reached its `running = true` guard.
          firstCallStarted();
          await releasePromise;
        }
        return makePnl({ wallet: address, chain: "solana", realized_pnl_usd: 100 });
      },
    });

    const worker = startWebhookWorker(app, { intervalMs: 60_000, getProviderImpl: slowProvider, fetchImpl: vi.fn() });

    const first = worker.runOnce();
    await firstCallStartedPromise;
    const second = worker.runOnce(); // should be skipped -- first is still in flight
    releaseFirst();
    await Promise.all([first, second]);

    expect(callCount).toBe(1);

    worker.stop();
    await app.close();
  });
});
