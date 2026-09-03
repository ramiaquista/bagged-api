import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { replaceDailyRealizedPnl } from "../db/dailyPnl.js";
import { listAllLinkedWallets } from "../db/userWallets.js";
import { getProvider } from "../providers/registry.js";
import { supportsDailyRealizedPnl } from "../providers/types.js";
import type { Chain } from "../schemas/chain.js";

/** Injectable seam for tests: a fake chain provider instead of the real Helius-backed one. */
export type GetProviderFn = (chain: Chain) => ReturnType<typeof getProvider>;

export interface DailyPnlWorkerOptions {
  /** Defaults to config.DAILY_PNL_POLL_INTERVAL_MS. */
  intervalMs?: number;
  /** Injectable for tests -- never hit a real chain provider from a test. */
  getProviderImpl?: GetProviderFn;
}

export interface DailyPnlWorkerHandle {
  stop: () => void;
  /** Runs one full cycle immediately and awaits its completion -- used by tests and by POST /user/wallets's immediate one-wallet recompute (via recomputeDailyPnlForWallet directly, not this). */
  runOnce: () => Promise<void>;
}

/**
 * Starts the background worker that keeps `daily_realized_pnl` (db/schema.sql)
 * up to date for every wallet any `/app` user has linked -- the source for
 * `/app`'s monthly PnL calendar (src/routes/user.ts's GET /user/calendar).
 *
 * Same lifecycle choice as src/worker/webhookWorker.ts and the same
 * reasons: started explicitly from src/index.ts (real server boot), never
 * from buildApp() (used by every test's app.inject(), no real socket or
 * lifetime) -- so the ~existing route test suite never spins up a
 * background timer that eventually makes real provider calls. This
 * worker's own tests (test/dailyPnlWorker.test.ts) drive `runOnce()`
 * directly instead of racing a timer.
 *
 * Runs are serialized the same way webhookWorker.ts's are: a tick still
 * running when the next would fire is skipped (logged), not queued.
 */
export function startDailyPnlWorker(app: FastifyInstance, options: DailyPnlWorkerOptions = {}): DailyPnlWorkerHandle {
  const intervalMs = options.intervalMs ?? config.DAILY_PNL_POLL_INTERVAL_MS;
  let running = false;

  async function runOnce(): Promise<void> {
    if (running) {
      app.log.warn("daily PnL worker: previous cycle still running, skipping this tick");
      return;
    }
    running = true;
    try {
      await runDailyPnlCheckCycle(app, options.getProviderImpl);
    } catch (err) {
      app.log.error({ err }, "daily PnL worker: cycle failed unexpectedly");
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref();

  return { runOnce, stop: () => clearInterval(timer) };
}

/**
 * Recomputes and stores real day-by-day realized PnL for one wallet.
 * Shared by the full-cycle worker below and by `POST /user/wallets`
 * (src/routes/user.ts), which calls this once, inline, right after a user
 * links a wallet -- so its calendar isn't empty until the next timer tick.
 *
 * No-ops (not an error) for a chain whose provider doesn't implement
 * DailyRealizedPnlProvider (see providers/types.ts's doc comment -- today,
 * every EVM chain) -- there's nothing real to compute yet.
 */
export async function recomputeDailyPnlForWallet(
  app: FastifyInstance,
  walletId: string,
  chain: Chain,
  address: string,
  getProviderImpl: GetProviderFn = getProvider,
): Promise<void> {
  const provider = getProviderImpl(chain);
  if (!supportsDailyRealizedPnl(provider)) return;

  const days = await provider.getWalletDailyRealizedPnl(address);
  await replaceDailyRealizedPnl(app.db, walletId, days);
}

/**
 * One full cycle: every distinct wallet linked by any `/app` user
 * (src/db/userWallets.ts's listAllLinkedWallets), recomputed in turn. A
 * failure on one wallet (provider error, DB error) is logged and skipped,
 * same "don't let one bad wallet abort the cycle" shape as
 * webhookWorker.ts's runWebhookCheckCycle.
 */
export async function runDailyPnlCheckCycle(
  app: FastifyInstance,
  getProviderImpl: GetProviderFn = getProvider,
): Promise<void> {
  const wallets = await listAllLinkedWallets(app.db);
  for (const { walletId, chain, address } of wallets) {
    try {
      await recomputeDailyPnlForWallet(app, walletId, chain, address, getProviderImpl);
    } catch (err) {
      app.log.error({ err, walletId, chain, address }, "daily PnL worker: failed to recompute wallet, skipping");
    }
  }
}
