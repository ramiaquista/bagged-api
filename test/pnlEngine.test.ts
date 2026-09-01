import { describe, expect, it } from "vitest";
import { computeCostBasis } from "../src/pnl-engine/costBasis.js";
import { resolveRugs } from "../src/pnl-engine/rugResolution.js";
import type { Trade } from "../src/pnl-engine/types.js";
import { filterWashTrades } from "../src/pnl-engine/washTrade.js";

function trade(overrides: Partial<Trade> & Pick<Trade, "side" | "quantity" | "priceUsd" | "timestamp">): Trade {
  return {
    txSignature: `sig-${Math.random().toString(36).slice(2)}`,
    chain: "solana",
    wallet: "wallet-1",
    tokenMintOrAddress: "MINT_A",
    ...overrides,
  };
}

describe("computeCostBasis", () => {
  it("computes zero-quantity, zero-cost, zero-pnl for no trades", () => {
    expect(computeCostBasis([])).toEqual({
      quantityHeld: 0,
      costBasisUsd: 0,
      realizedPnlUsd: 0,
    });
  });

  it("tracks a simple full buy-then-sell round trip", () => {
    const trades = [
      trade({ side: "buy", quantity: 100, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
      trade({ side: "sell", quantity: 100, priceUsd: 2, timestamp: "2026-01-02T00:00:00.000Z" }),
    ];
    const result = computeCostBasis(trades);
    expect(result.quantityHeld).toBe(0);
    expect(result.costBasisUsd).toBe(0);
    expect(result.realizedPnlUsd).toBeCloseTo(100, 6);
  });

  it("uses weighted-average cost across multiple buys for a partial sell", () => {
    const trades = [
      trade({ side: "buy", quantity: 100, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
      trade({ side: "buy", quantity: 100, priceUsd: 3, timestamp: "2026-01-02T00:00:00.000Z" }),
      // avg cost so far: (100 + 300) / 200 = $2/unit
      trade({ side: "sell", quantity: 50, priceUsd: 5, timestamp: "2026-01-03T00:00:00.000Z" }),
    ];
    const result = computeCostBasis(trades);
    // realized: 50 * (5 - 2) = 150
    expect(result.realizedPnlUsd).toBeCloseTo(150, 6);
    // remaining: 150 units at $2 avg cost = $300
    expect(result.quantityHeld).toBeCloseTo(150, 6);
    expect(result.costBasisUsd).toBeCloseTo(300, 6);
  });

  it("sorts trades by timestamp internally regardless of input order", () => {
    const trades = [
      trade({ side: "sell", quantity: 100, priceUsd: 2, timestamp: "2026-01-02T00:00:00.000Z" }),
      trade({ side: "buy", quantity: 100, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
    ];
    const result = computeCostBasis(trades);
    expect(result.realizedPnlUsd).toBeCloseTo(100, 6);
    expect(result.quantityHeld).toBe(0);
  });

  it("treats an oversell beyond tracked history as zero-cost-basis proceeds", () => {
    // No prior buy in the fetched window (e.g. tokens acquired before the
    // indexed range, or via transfer/airdrop) -- selling still books real
    // USD received.
    const trades = [
      trade({ side: "sell", quantity: 10, priceUsd: 5, timestamp: "2026-01-01T00:00:00.000Z" }),
    ];
    const result = computeCostBasis(trades);
    expect(result.realizedPnlUsd).toBeCloseTo(50, 6);
    expect(result.quantityHeld).toBe(0);
    expect(result.costBasisUsd).toBe(0);
  });

  it("ignores non-finite or non-positive-quantity trades defensively", () => {
    const trades = [
      trade({ side: "buy", quantity: 0, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
      trade({ side: "buy", quantity: 10, priceUsd: Number.NaN, timestamp: "2026-01-01T00:00:01.000Z" }),
      trade({ side: "buy", quantity: 10, priceUsd: 1, timestamp: "2026-01-01T00:00:02.000Z" }),
    ];
    const result = computeCostBasis(trades);
    expect(result.quantityHeld).toBe(10);
    expect(result.costBasisUsd).toBe(10);
  });
});

describe("filterWashTrades", () => {
  it("passes through trades with no round-trip pattern", () => {
    const trades = [
      trade({ side: "buy", quantity: 100, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
    ];
    const result = filterWashTrades(trades);
    expect(result.excludedCount).toBe(0);
    expect(result.cleanTrades).toHaveLength(1);
  });

  it("excludes a buy immediately followed by a same-size opposite sell", () => {
    const trades = [
      trade({ side: "buy", quantity: 100, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
      trade({ side: "sell", quantity: 100, priceUsd: 1.001, timestamp: "2026-01-01T00:00:01.000Z" }),
    ];
    const result = filterWashTrades(trades);
    expect(result.excludedCount).toBe(2);
    expect(result.cleanTrades).toHaveLength(0);
  });

  it("does not exclude a round trip outside the wash window", () => {
    const trades = [
      trade({ side: "buy", quantity: 100, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
      trade({ side: "sell", quantity: 100, priceUsd: 1.5, timestamp: "2026-01-01T00:01:00.000Z" }),
    ];
    const result = filterWashTrades(trades);
    expect(result.excludedCount).toBe(0);
    expect(result.cleanTrades).toHaveLength(2);
  });

  it("does not exclude a round trip with mismatched quantities", () => {
    const trades = [
      trade({ side: "buy", quantity: 100, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
      trade({ side: "sell", quantity: 40, priceUsd: 1.001, timestamp: "2026-01-01T00:00:01.000Z" }),
    ];
    const result = filterWashTrades(trades);
    expect(result.excludedCount).toBe(0);
    expect(result.cleanTrades).toHaveLength(2);
  });

  it("only flags trades in the same token", () => {
    const trades = [
      trade({
        side: "buy",
        quantity: 100,
        priceUsd: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        tokenMintOrAddress: "MINT_A",
      }),
      trade({
        side: "sell",
        quantity: 100,
        priceUsd: 1,
        timestamp: "2026-01-01T00:00:01.000Z",
        tokenMintOrAddress: "MINT_B",
      }),
    ];
    const result = filterWashTrades(trades);
    expect(result.excludedCount).toBe(0);
    expect(result.cleanTrades).toHaveLength(2);
  });
});

describe("resolveRugs", () => {
  it("does not flag a token still holding a small buy with no later collapse", () => {
    const trades = [
      trade({ side: "buy", quantity: 100, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
    ];
    // Single trade -- below MIN_TRADES_FOR_SIGNAL, never flagged.
    const result = resolveRugs(trades);
    expect(result.resolvedCount).toBe(0);
    expect(result.realizedLossUsd).toBe(0);
  });

  it("force-resolves a token whose price collapsed to near zero while still held", () => {
    const trades = [
      trade({ side: "buy", quantity: 1000, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
      trade({ side: "buy", quantity: 1000, priceUsd: 0.00001, timestamp: "2026-01-02T00:00:00.000Z" }),
    ];
    const result = resolveRugs(trades);
    expect(result.resolvedCount).toBe(1);
    // residual cost basis: 1000*1 + 1000*0.00001 = ~1000.01
    expect(result.realizedLossUsd).toBeCloseTo(1000.01, 2);
  });

  it("does not flag a token that was fully exited before collapsing", () => {
    const trades = [
      trade({ side: "buy", quantity: 1000, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
      trade({ side: "sell", quantity: 1000, priceUsd: 0.00001, timestamp: "2026-01-02T00:00:00.000Z" }),
    ];
    const result = resolveRugs(trades);
    expect(result.resolvedCount).toBe(0);
  });

  it("does not flag a token that dipped but did not collapse", () => {
    const trades = [
      trade({ side: "buy", quantity: 1000, priceUsd: 1, timestamp: "2026-01-01T00:00:00.000Z" }),
      trade({ side: "buy", quantity: 1000, priceUsd: 0.5, timestamp: "2026-01-02T00:00:00.000Z" }),
    ];
    const result = resolveRugs(trades);
    expect(result.resolvedCount).toBe(0);
  });

  it("aggregates across multiple rugged tokens when given a wallet's full history", () => {
    const trades = [
      trade({
        tokenMintOrAddress: "MINT_A",
        side: "buy",
        quantity: 1000,
        priceUsd: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      trade({
        tokenMintOrAddress: "MINT_A",
        side: "buy",
        quantity: 1000,
        priceUsd: 0.00001,
        timestamp: "2026-01-02T00:00:00.000Z",
      }),
      trade({
        tokenMintOrAddress: "MINT_B",
        side: "buy",
        quantity: 500,
        priceUsd: 2,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      trade({
        tokenMintOrAddress: "MINT_B",
        side: "buy",
        quantity: 500,
        priceUsd: 0.00002,
        timestamp: "2026-01-02T00:00:00.000Z",
      }),
    ];
    const result = resolveRugs(trades);
    expect(result.resolvedCount).toBe(2);
    expect(result.realizedLossUsd).toBeGreaterThan(1000);
  });
});
