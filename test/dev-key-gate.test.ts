import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Integration-level regression test for the ALLOW_DEV_KEY gate: builds the
 * app fresh with the env var unset (module-reset so src/config.ts's
 * top-level `config` singleton re-evaluates), unlike every other test file
 * which relies on vitest.config.ts's global ALLOW_DEV_KEY=true.
 */
describe("dev key gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rejects the literal \"dev\" key when ALLOW_DEV_KEY is unset", async () => {
    vi.stubEnv("ALLOW_DEV_KEY", undefined);
    vi.resetModules();
    const { buildApp } = await import("../src/app.js");

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": "dev" },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
