import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const headers = { "x-api-key": "dev" };

describe("wallet routes", () => {
  it("GET /wallet/:address/pnl returns a WalletPnl shape per chain", async () => {
    const app = await buildApp();
    for (const chain of ["solana", "bnb", "robinhood", "ethereum"]) {
      const res = await app.inject({
        method: "GET",
        url: `/wallet/some-address/pnl?chain=${chain}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.chain).toBe(chain);
      expect(body.realized_pnl_usd + body.unrealized_pnl_usd).toBeCloseTo(body.total_pnl_usd, 5);
    }
    await app.close();
  });

  it("rejects an unknown chain", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/wallet/some-address/pnl?chain=dogecoin",
      headers,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /wallet/:address/positions returns a positions array", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/wallet/some-address/positions?chain=solana",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().positions)).toBe(true);
    await app.close();
  });

  it("POST /wallets/batch returns one result per wallet", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/wallets/batch",
      headers,
      payload: {
        wallets: [
          { address: "a", chain: "solana" },
          { address: "b", chain: "bnb" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(2);
    await app.close();
  });
});
