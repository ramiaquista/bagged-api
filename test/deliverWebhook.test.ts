import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { deliverWebhook, type WebhookDeliveryPayload } from "../src/worker/deliver.js";

// A fake FastifyBaseLogger -- captures calls without any real pino/stdout
// wiring, and without pulling `pino` in as a direct test dependency.
function fakeLogger(): FastifyBaseLogger {
  const logger = {
    level: "info",
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger as unknown as FastifyBaseLogger;
}

const PAYLOAD: WebhookDeliveryPayload = {
  webhook_id: "webhook-1",
  wallet: "abc",
  chain: "solana",
  threshold_pct: 10,
  change_pct: 25,
  previous_total_pnl_usd: 100,
  current_total_pnl_usd: 125,
  triggered_at: "2026-01-01T00:00:00.000Z",
};

describe("worker/deliver", () => {
  it("succeeds on the first attempt without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const logger = fakeLogger();

    const delivered = await deliverWebhook("https://example.com/hook", PAYLOAD, logger, {
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
    });

    expect(delivered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({ method: "POST", body: JSON.stringify(PAYLOAD) }),
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("retries after a non-2xx response, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    const delivered = await deliverWebhook("https://example.com/hook", PAYLOAD, logger, {
      fetchImpl,
      sleepImpl,
      maxRetries: 2,
      backoffMs: 100,
    });

    expect(delivered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(100); // backoffMs * 2^0
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("retries after a network error, then succeeds", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    const delivered = await deliverWebhook("https://example.com/hook", PAYLOAD, logger, {
      fetchImpl,
      sleepImpl,
    });

    expect(delivered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting all retries, backing off exponentially, and returns false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    const delivered = await deliverWebhook("https://example.com/hook", PAYLOAD, logger, {
      fetchImpl,
      sleepImpl,
      maxRetries: 2,
      backoffMs: 100,
    });

    expect(delivered).toBe(false);
    // 1 initial attempt + 2 retries = 3 total attempts.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 100); // 100 * 2^0
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 200); // 100 * 2^1
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one attempt when maxRetries is 0", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    const delivered = await deliverWebhook("https://example.com/hook", PAYLOAD, logger, {
      fetchImpl,
      sleepImpl,
      maxRetries: 0,
    });

    expect(delivered).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("never touches the real network -- fetchImpl is always the injected fake", async () => {
    // Guards against a future refactor accidentally dropping the
    // fetchImpl override and falling back to the real global fetch.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await deliverWebhook("https://this-host-does-not-exist.invalid/hook", PAYLOAD, fakeLogger(), { fetchImpl });
    expect(fetchImpl).toHaveBeenCalled();
  });
});
