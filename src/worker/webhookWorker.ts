import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getLatestPnlSnapshot, insertPnlSnapshot } from "../db/pnlSnapshots.js";
import { listWebhooksForDelivery, type WebhookDeliveryTarget } from "../db/webhooks.js";
import { getProvider } from "../providers/registry.js";
import type { Chain } from "../schemas/chain.js";
import type { WalletPnl } from "../schemas/pnl.js";
import { deliverWebhook } from "./deliver.js";
import { computePnlChangePct, hasCrossedThreshold } from "./pnlDiff.js";

/** Injectable seam for tests: a fake chain provider instead of the real Helius/Alchemy-backed ones. */
export type GetProviderFn = (chain: Chain) => { getWalletPnl(address: string): Promise<WalletPnl> };

export interface WebhookWorkerOptions {
  /** Defaults to config.WEBHOOK_POLL_INTERVAL_MS. */
  intervalMs?: number;
  /** Injectable for tests -- never hit a real chain provider from a test. */
  getProviderImpl?: GetProviderFn;
  /** Injectable for tests -- never make a real network call from a test. */
  fetchImpl?: typeof fetch;
}

export interface WebhookWorkerHandle {
  /** Stops the timer. Safe to call more than once. */
  stop: () => void;
  /** Runs one check cycle immediately and awaits its completion -- used by tests, and available for an ops-triggered manual run. */
  runOnce: () => Promise<void>;
}

/**
 * Starts the webhook delivery worker (NEXT_STEPS.md Item 6): on a timer,
 * checks every wallet with at least one registered webhook, and delivers to
 * `url` when `threshold_pct` is crossed. See runWebhookCheckCycle for the
 * actual per-tick logic.
 *
 * LIFECYCLE CHOICE: started explicitly from src/index.ts (the real
 * server-boot entrypoint), not registered as a Fastify plugin inside
 * src/app.ts. buildApp() is called by every test in test/*.test.ts via
 * app.inject() (no real listening socket) -- if the worker were wired into
 * buildApp() itself, every one of those tests would spin up a background
 * timer that (eventually) makes real provider/network calls, with no clean
 * way to await or assert its behavior. Keeping it out of app.ts means the
 * ~40 existing route tests are unaffected, and this worker gets its own
 * focused tests (test/webhookWorker.test.ts) that drive `runOnce()`
 * directly instead of racing a timer.
 *
 * Runs are serialized: if a tick is still running when the next one would
 * fire, the next one is skipped (logged, not queued) so a slow provider
 * call or a burst of registered wallets can't pile up overlapping cycles.
 */
export function startWebhookWorker(app: FastifyInstance, options: WebhookWorkerOptions = {}): WebhookWorkerHandle {
  const intervalMs = options.intervalMs ?? config.WEBHOOK_POLL_INTERVAL_MS;
  let running = false;

  async function runOnce(): Promise<void> {
    if (running) {
      app.log.warn("webhook worker: previous cycle still running, skipping this tick");
      return;
    }
    running = true;
    try {
      await runWebhookCheckCycle(app, options.getProviderImpl, options.fetchImpl);
    } catch (err) {
      app.log.error({ err }, "webhook worker: cycle failed unexpectedly");
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  // Doesn't hold the process open on its own -- app.close()/process exit
  // (src/index.ts) is what actually governs process lifetime.
  timer.unref();

  return {
    runOnce,
    stop: () => clearInterval(timer),
  };
}

/**
 * One full check cycle: every registered webhook, grouped by wallet (a
 * wallet can have more than one webhook registered against it, e.g. two
 * different thresholds), fetch that wallet's current PnL exactly once,
 * record it as a new `pnl_snapshots` row, diff it against the
 * immediately-prior snapshot, and deliver to each webhook whose
 * `threshold_pct` is crossed.
 *
 * A failure checking one wallet (provider error, DB error) is logged and
 * skipped -- it doesn't abort the rest of the cycle for other wallets.
 */
export async function runWebhookCheckCycle(
  app: FastifyInstance,
  getProviderImpl: GetProviderFn = getProvider,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const targets = await listWebhooksForDelivery(app.db);
  if (targets.length === 0) return;

  const byWallet = new Map<string, WebhookDeliveryTarget[]>();
  for (const target of targets) {
    const existing = byWallet.get(target.walletId);
    if (existing) {
      existing.push(target);
    } else {
      byWallet.set(target.walletId, [target]);
    }
  }

  for (const [walletId, webhooks] of byWallet) {
    const first = webhooks[0];
    if (!first) continue; // unreachable (byWallet only ever gets non-empty arrays), keeps noUncheckedIndexedAccess happy
    const { chain, address } = first;

    try {
      const previous = await getLatestPnlSnapshot(app.db, walletId);
      const current = await getProviderImpl(chain).getWalletPnl(address);

      await insertPnlSnapshot(app.db, {
        walletId,
        realizedPnlUsd: current.realized_pnl_usd,
        unrealizedPnlUsd: current.unrealized_pnl_usd,
        positionsOpen: current.positions_open,
        washTradesExcluded: current.wash_trades_excluded,
        rugsResolved: current.rugs_resolved,
      });

      const previousTotal = previous ? previous.realizedPnlUsd + previous.unrealizedPnlUsd : null;

      for (const webhook of webhooks) {
        if (!hasCrossedThreshold(previousTotal, current.total_pnl_usd, webhook.thresholdPct)) {
          continue;
        }

        app.log.info(
          {
            webhookId: webhook.id,
            wallet: address,
            chain,
            previousTotal,
            currentTotal: current.total_pnl_usd,
            thresholdPct: webhook.thresholdPct,
          },
          "webhook threshold crossed, delivering",
        );

        await deliverWebhook(
          webhook.url,
          {
            webhook_id: webhook.id,
            wallet: address,
            chain,
            threshold_pct: webhook.thresholdPct,
            change_pct: computePnlChangePct(previousTotal, current.total_pnl_usd),
            previous_total_pnl_usd: previousTotal,
            current_total_pnl_usd: current.total_pnl_usd,
            triggered_at: new Date().toISOString(),
          },
          app.log,
          {
            maxRetries: config.WEBHOOK_DELIVERY_MAX_RETRIES,
            backoffMs: config.WEBHOOK_DELIVERY_BACKOFF_MS,
            fetchImpl,
          },
        );
      }
    } catch (err) {
      app.log.error({ err, walletId, chain, address }, "webhook worker: failed to check wallet, skipping");
    }
  }
}
