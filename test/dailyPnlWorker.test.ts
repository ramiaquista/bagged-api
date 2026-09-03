import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { listDailyRealizedPnl } from "../src/db/dailyPnl.js";
import { createPool } from "../src/db/pool.js";
import { findOrCreateWallet } from "../src/db/wallets.js";
import type { ChainProvider, DailyRealizedPnl } from "../src/providers/types.js";
import type { WalletPnl } from "../src/schemas/pnl.js";
import { recomputeDailyPnlForWallet, runDailyPnlCheckCycle } from "../src/worker/dailyPnlWorker.js";

// Real integration tests against Postgres, matching test/partner.test.ts's
// pattern. `truncate table wallets cascade` sweeps daily_realized_pnl too
// (see db/schema.sql's `on delete cascade`), so tests here don't leak
// stale rows into each other even though the fake provider below never
// touches Helius.
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table wallets cascade");
});

afterAll(async () => {
  await pool.end();
});

/** A fake chain provider whose daily-realized figures are hardcoded, for injection via getProviderImpl -- never a real network call from a test. */
function fakeDailyProvider(days: DailyRealizedPnl[]): ChainProvider & { getWalletDailyRealizedPnl(address: string): Promise<DailyRealizedPnl[]> } {
  return {
    chain: "solana",
    async getWalletPnl(): Promise<WalletPnl> {
      throw new Error("not used by these tests");
    },
    async getWalletPositions() {
      return [];
    },
    async getWalletDailyRealizedPnl() {
      return days;
    },
  };
}

/** A fake provider that does NOT implement the optional daily-realized capability -- mirrors EvmProvider's current (mock-data) state. */
function fakeProviderWithoutDailySupport(): ChainProvider {
  return {
    chain: "bnb",
    async getWalletPnl(): Promise<WalletPnl> {
      return {
        wallet: "x",
        chain: "bnb",
        realized_pnl_usd: 0,
        unrealized_pnl_usd: 0,
        total_pnl_usd: 0,
        positions_open: 0,
        wash_trades_excluded: 0,
        rugs_resolved: 0,
        as_of: new Date().toISOString(),
      };
    },
    async getWalletPositions() {
      return [];
    },
  };
}

describe("recomputeDailyPnlForWallet", () => {
  it("stores the provider's daily-realized rows for the wallet", async () => {
    const app = await buildApp();
    const wallet = await findOrCreateWallet(app.db, "solana", "daily-worker-wallet-1");

    await recomputeDailyPnlForWallet(app, wallet.id, "solana", wallet.address, () =>
      fakeDailyProvider([
        { day: "2026-09-01", realizedPnlUsd: 120.5, tradeCount: 2 },
        { day: "2026-09-02", realizedPnlUsd: -40, tradeCount: 1 },
      ]),
    );

    const rows = await listDailyRealizedPnl(app.db, [wallet.id], "2026-09-01", "2026-09-30");
    expect(rows).toEqual([
      { walletId: wallet.id, day: "2026-09-01", realizedPnlUsd: 120.5, tradeCount: 2 },
      { walletId: wallet.id, day: "2026-09-02", realizedPnlUsd: -40, tradeCount: 1 },
    ]);

    await app.close();
  });

  it("replaces stale days wholesale rather than merging", async () => {
    const app = await buildApp();
    const wallet = await findOrCreateWallet(app.db, "solana", "daily-worker-wallet-2");

    await recomputeDailyPnlForWallet(app, wallet.id, "solana", wallet.address, () =>
      fakeDailyProvider([{ day: "2026-09-01", realizedPnlUsd: 100, tradeCount: 1 }]),
    );
    // Second compute no longer has 09-01 (e.g. it fell out of the
    // indexer's window) and has a different 09-02 figure -- the stored
    // set should exactly match the latest compute, not accumulate both.
    await recomputeDailyPnlForWallet(app, wallet.id, "solana", wallet.address, () =>
      fakeDailyProvider([{ day: "2026-09-02", realizedPnlUsd: 55, tradeCount: 3 }]),
    );

    const rows = await listDailyRealizedPnl(app.db, [wallet.id], "2026-09-01", "2026-09-30");
    expect(rows).toEqual([{ walletId: wallet.id, day: "2026-09-02", realizedPnlUsd: 55, tradeCount: 3 }]);

    await app.close();
  });

  it("no-ops for a chain whose provider doesn't implement the daily-realized capability", async () => {
    const app = await buildApp();
    const wallet = await findOrCreateWallet(app.db, "bnb", "daily-worker-wallet-3");

    await expect(
      recomputeDailyPnlForWallet(app, wallet.id, "bnb", wallet.address, () => fakeProviderWithoutDailySupport()),
    ).resolves.toBeUndefined();

    const rows = await listDailyRealizedPnl(app.db, [wallet.id], "2026-01-01", "2026-12-31");
    expect(rows).toEqual([]);

    await app.close();
  });
});

describe("runDailyPnlCheckCycle", () => {
  it("recomputes every distinct wallet linked by any user, skipping unsupported chains", async () => {
    const app = await buildApp();
    const solWallet = await findOrCreateWallet(app.db, "solana", "daily-worker-cycle-sol");
    const bnbWallet = await findOrCreateWallet(app.db, "bnb", "daily-worker-cycle-bnb");

    const userRes = await app.inject({
      method: "POST",
      url: "/user/signup",
      payload: { email: "cycle@example.com", password: "correct-horse-battery" },
    });
    const cookie = userRes.cookies.find((c) => c.name === "bagged_user_session")!;
    await app.inject({
      method: "POST",
      url: "/user/wallets",
      cookies: { bagged_user_session: cookie.value },
      payload: { chain: "solana", address: solWallet.address },
    });
    await app.inject({
      method: "POST",
      url: "/user/wallets",
      cookies: { bagged_user_session: cookie.value },
      payload: { chain: "bnb", address: bnbWallet.address },
    });

    await runDailyPnlCheckCycle(app, (chain) =>
      chain === "solana" ? fakeDailyProvider([{ day: "2026-09-05", realizedPnlUsd: 9, tradeCount: 1 }]) : fakeProviderWithoutDailySupport(),
    );

    const solRows = await listDailyRealizedPnl(app.db, [solWallet.id], "2026-09-01", "2026-09-30");
    expect(solRows).toEqual([{ walletId: solWallet.id, day: "2026-09-05", realizedPnlUsd: 9, tradeCount: 1 }]);
    const bnbRows = await listDailyRealizedPnl(app.db, [bnbWallet.id], "2026-01-01", "2026-12-31");
    expect(bnbRows).toEqual([]);

    await app.close();
  });

  it("does nothing when no wallet is linked by any user", async () => {
    const app = await buildApp();
    await expect(runDailyPnlCheckCycle(app)).resolves.toBeUndefined();
    await app.close();
  });
});
