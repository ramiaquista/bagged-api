import type { FastifyBaseLogger } from "fastify";

export interface WebhookDeliveryPayload {
  webhook_id: string;
  wallet: string;
  chain: string;
  threshold_pct: number;
  /** null when a real percentage couldn't be computed -- see pnlDiff.ts. */
  change_pct: number | null;
  previous_total_pnl_usd: number | null;
  current_total_pnl_usd: number;
  triggered_at: string;
}

export interface DeliverWebhookOptions {
  /** Additional attempts after the first. Default from config.WEBHOOK_DELIVERY_MAX_RETRIES. */
  maxRetries?: number;
  /** Base backoff before the first retry, doubled on each subsequent one. */
  backoffMs?: number;
  /** Injectable for tests -- never make a real network call from a test. */
  fetchImpl?: typeof fetch;
  /** Per-attempt request timeout. */
  timeoutMs?: number;
  /** Injectable for tests, so retry backoff doesn't actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs a webhook payload to `url`, retrying a small, fixed number of times
 * with exponential backoff on failure (network error, timeout, or a
 * non-2xx response). This is a v1 background-worker delivery helper, not a
 * durable job queue: attempts happen in-process, in-memory, during one
 * worker tick -- a delivery that still fails after all retries is logged
 * and dropped (see runWebhookCheckCycle in webhookWorker.ts), not persisted
 * for a later retry.
 *
 * Every attempt (success, non-2xx, and network/timeout failure) is logged
 * via the passed-in logger (the app's existing pino-backed
 * `FastifyBaseLogger`, per the project's logging pattern -- no new logging
 * library).
 *
 * Returns `true` if delivery eventually succeeded, `false` if every
 * attempt failed.
 */
export async function deliverWebhook(
  url: string,
  payload: WebhookDeliveryPayload,
  logger: FastifyBaseLogger,
  options: DeliverWebhookOptions = {},
): Promise<boolean> {
  const maxRetries = options.maxRetries ?? 2;
  const backoffMs = options.backoffMs ?? 500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const sleep = options.sleepImpl ?? defaultSleep;

  const totalAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (res.ok) {
        logger.info(
          { url, webhookId: payload.webhook_id, attempt, totalAttempts, status: res.status },
          "webhook delivered",
        );
        return true;
      }

      logger.warn(
        { url, webhookId: payload.webhook_id, attempt, totalAttempts, status: res.status },
        "webhook delivery received a non-2xx response",
      );
    } catch (err) {
      logger.warn(
        { url, webhookId: payload.webhook_id, attempt, totalAttempts, err: (err as Error).message },
        "webhook delivery attempt failed",
      );
    } finally {
      clearTimeout(timeout);
    }

    const isLastAttempt = attempt === totalAttempts;
    if (!isLastAttempt) {
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }

  logger.error(
    { url, webhookId: payload.webhook_id, totalAttempts },
    "webhook delivery failed after all retries, dropping",
  );
  return false;
}
