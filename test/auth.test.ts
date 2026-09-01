import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("API key auth", () => {
  it("rejects requests without an x-api-key header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/wallet/abc/pnl?chain=solana" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts the dev key", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/wallet/abc/pnl?chain=solana",
      headers: { "x-api-key": "dev" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
