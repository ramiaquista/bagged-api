import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { CARD_RATE_LIMIT } from "../src/routes/card.js";

// Public shareable PnL-card tool (NEXT_STEPS.md Item 4). Unlike
// test/wallet.test.ts / test/auth.test.ts, these requests deliberately
// carry NO x-api-key header -- that's the whole point of this route.
describe("public card route", () => {
  it("returns a WalletPnl shape with no x-api-key header", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/card/some-address/pnl?chain=solana",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chain).toBe("solana");
    expect(body.wallet).toBe("some-address");
    expect(body.realized_pnl_usd + body.unrealized_pnl_usd).toBeCloseTo(body.total_pnl_usd, 5);
    await app.close();
  });

  it("works across every chain, still with no api key", async () => {
    const app = await buildApp();
    for (const chain of ["solana", "bnb", "robinhood", "ethereum"]) {
      const res = await app.inject({
        method: "GET",
        url: `/card/some-address/pnl?chain=${chain}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().chain).toBe(chain);
    }
    await app.close();
  });

  it("rejects an unknown chain with 400, not 401/500", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/card/some-address/pnl?chain=dogecoin",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("does NOT fall back to requiring x-api-key even though every other route does", async () => {
    const app = await buildApp();
    const withoutKey = await app.inject({
      method: "GET",
      url: "/card/some-address/pnl?chain=solana",
    });
    const otherRouteWithoutKey = await app.inject({
      method: "GET",
      url: "/wallet/some-address/pnl?chain=solana",
    });
    expect(withoutKey.statusCode).toBe(200);
    expect(otherRouteWithoutKey.statusCode).toBe(401);
    await app.close();
  });

  it("rate-limits far more strictly than the authenticated default, returning 429 once exceeded", async () => {
    const app = await buildApp();

    let lastStatus = 0;
    for (let i = 0; i < CARD_RATE_LIMIT.max + 1; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/card/rate-limit-test-wallet/pnl?chain=solana",
      });
      lastStatus = res.statusCode;
    }

    // The request just past the configured max must be rejected.
    expect(lastStatus).toBe(429);
    await app.close();
  });

  it("keeps the authenticated /wallet route's own limit independent (100/min) from the card route's", async () => {
    const app = await buildApp();

    // Exhaust the card route's limit...
    for (let i = 0; i < CARD_RATE_LIMIT.max; i++) {
      await app.inject({ method: "GET", url: "/card/x/pnl?chain=solana" });
    }
    const cardRes = await app.inject({ method: "GET", url: "/card/x/pnl?chain=solana" });
    expect(cardRes.statusCode).toBe(429);

    // ...the authenticated route, hit far fewer times than its own (much
    // higher) global limit, must still succeed.
    const walletRes = await app.inject({
      method: "GET",
      url: "/wallet/x/pnl?chain=solana",
      headers: { "x-api-key": "dev" },
    });
    expect(walletRes.statusCode).toBe(200);

    await app.close();
  });
});
