import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests, not integration tests -- no Postgres needed (unlike
// test/waitlist.test.ts). Mirrors test/solanaProvider.test.ts's pattern of
// mocking ../src/config.js directly to control an optional-key env var
// per test, rather than threading it through as a function parameter.

function fakeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as import("fastify").FastifyBaseLogger;
}

describe("notifyWaitlistSignup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("no-ops (and never calls fetch) when RESEND_API_KEY is unset", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { RESEND_API_KEY: undefined, WAITLIST_NOTIFY_EMAIL: "business@bagged.life" },
    }));
    const { notifyWaitlistSignup } = await import("../src/lib/waitlistNotify.js");
    const fetchImpl = vi.fn();
    const logger = fakeLogger();

    const sent = await notifyWaitlistSignup({ email: "trader@example.com" }, logger, { fetchImpl });

    expect(sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ email: "trader@example.com" }),
      expect.stringContaining("RESEND_API_KEY not set"),
    );
  });

  it("POSTs to Resend with the signup's email as reply-to when configured", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { RESEND_API_KEY: "re_test_key", WAITLIST_NOTIFY_EMAIL: "business@bagged.life" },
    }));
    const { notifyWaitlistSignup } = await import("../src/lib/waitlistNotify.js");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const logger = fakeLogger();

    const sent = await notifyWaitlistSignup(
      { email: "trader@example.com", note: "building a bot" },
      logger,
      { fetchImpl },
    );

    expect(sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    const [url, init] = call;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(["business@bagged.life"]);
    expect(body.reply_to).toBe("trader@example.com");
    expect(body.subject).toContain("trader@example.com");
    expect(body.text).toContain("building a bot");
  });

  it("omits a note line gracefully and still sends when note is absent", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { RESEND_API_KEY: "re_test_key", WAITLIST_NOTIFY_EMAIL: "business@bagged.life" },
    }));
    const { notifyWaitlistSignup } = await import("../src/lib/waitlistNotify.js");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await notifyWaitlistSignup({ email: "noNote@example.com" }, fakeLogger(), { fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.text).toContain("(no note provided)");
  });

  it("returns false and logs a warning, without throwing, on a non-2xx response", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { RESEND_API_KEY: "re_test_key", WAITLIST_NOTIFY_EMAIL: "business@bagged.life" },
    }));
    const { notifyWaitlistSignup } = await import("../src/lib/waitlistNotify.js");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "bad request" });
    const logger = fakeLogger();

    const sent = await notifyWaitlistSignup({ email: "trader@example.com" }, logger, { fetchImpl });

    expect(sent).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 422 }),
      expect.stringContaining("failed to send"),
    );
  });

  it("returns false and logs a warning, without throwing, when fetch itself rejects", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { RESEND_API_KEY: "re_test_key", WAITLIST_NOTIFY_EMAIL: "business@bagged.life" },
    }));
    const { notifyWaitlistSignup } = await import("../src/lib/waitlistNotify.js");
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const logger = fakeLogger();

    await expect(
      notifyWaitlistSignup({ email: "trader@example.com" }, logger, { fetchImpl }),
    ).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: "network down" }),
      expect.stringContaining("threw"),
    );
  });
});
