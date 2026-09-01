import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /portfolio/:userId", () => {
  it("rolls up PnL across all four chains", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/portfolio/user-123",
      headers: { "x-api-key": "dev" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wallets).toHaveLength(4);
    expect(body.total_pnl_usd).toBeGreaterThan(0);
    await app.close();
  });
});
