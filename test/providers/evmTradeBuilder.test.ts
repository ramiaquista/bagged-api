import { describe, expect, it } from "vitest";
import type { AssetTransfer } from "../../src/providers/alchemy/client.js";
import { buildTradesFromTransfers } from "../../src/providers/evmTradeBuilder.js";
import type { LaunchpadResolver } from "../../src/providers/launchpads/types.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "0xtoken0000000000000000000000000000000001";
const CURVE = "0xcurve0000000000000000000000000000000001";
const ROUTER = "0xrouter000000000000000000000000000000001";

const noopLaunchpad: LaunchpadResolver = {
  name: "noop",
  isBondingCurveAddress: () => false,
};

function bondingCurveLaunchpad(address: string): LaunchpadResolver {
  return {
    name: "test-curve",
    isBondingCurveAddress: (a) => a.toLowerCase() === address.toLowerCase(),
  };
}

function transfer(overrides: Partial<AssetTransfer> & Pick<AssetTransfer, "hash" | "from" | "to" | "category">): AssetTransfer {
  return {
    asset: null,
    value: null,
    tokenAddress: null,
    blockTimestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildTradesFromTransfers", () => {
  it("pairs a native-out + token-in leg into a priced buy", () => {
    const transfers: AssetTransfer[] = [
      transfer({ hash: "0x1", from: WALLET, to: ROUTER, category: "external", value: 1 }),
      transfer({ hash: "0x1", from: ROUTER, to: WALLET, category: "erc20", value: 1000, tokenAddress: TOKEN, asset: "CHAD" }),
    ];

    const trades = buildTradesFromTransfers(WALLET, "bnb", transfers, 600, noopLaunchpad);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      side: "buy",
      quantity: 1000,
      priceUsd: 0.6, // 1 native * $600 / 1000 tokens
      tokenMintOrAddress: TOKEN,
      preGraduation: false,
    });
  });

  it("pairs a token-out + native-in leg into a priced sell", () => {
    const transfers: AssetTransfer[] = [
      transfer({ hash: "0x2", from: WALLET, to: ROUTER, category: "erc20", value: 500, tokenAddress: TOKEN, asset: "CHAD" }),
      transfer({ hash: "0x2", from: ROUTER, to: WALLET, category: "external", value: 2 }),
    ];

    const trades = buildTradesFromTransfers(WALLET, "ethereum", transfers, 2000, noopLaunchpad);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      side: "sell",
      quantity: 500,
      priceUsd: 8, // 2 native * $2000 / 500 tokens
    });
  });

  it("tags a fill as preGraduation when it touches a known bonding-curve contract", () => {
    const transfers: AssetTransfer[] = [
      transfer({ hash: "0x3", from: WALLET, to: CURVE, category: "external", value: 1 }),
      transfer({ hash: "0x3", from: CURVE, to: WALLET, category: "erc20", value: 100, tokenAddress: TOKEN, asset: "MOON" }),
    ];

    const trades = buildTradesFromTransfers(WALLET, "bnb", transfers, 600, bondingCurveLaunchpad(CURVE));

    expect(trades).toHaveLength(1);
    expect(trades[0]!.preGraduation).toBe(true);
  });

  it("skips token-for-token swaps (no native leg to price against)", () => {
    const otherToken = "0xtoken0000000000000000000000000000000002";
    const transfers: AssetTransfer[] = [
      transfer({ hash: "0x4", from: WALLET, to: ROUTER, category: "erc20", value: 100, tokenAddress: TOKEN, asset: "A" }),
      transfer({ hash: "0x4", from: ROUTER, to: WALLET, category: "erc20", value: 50, tokenAddress: otherToken, asset: "B" }),
    ];

    const trades = buildTradesFromTransfers(WALLET, "bnb", transfers, 600, noopLaunchpad);

    expect(trades).toHaveLength(0);
  });

  it("skips everything when no native price is available", () => {
    const transfers: AssetTransfer[] = [
      transfer({ hash: "0x5", from: WALLET, to: ROUTER, category: "external", value: 1 }),
      transfer({ hash: "0x5", from: ROUTER, to: WALLET, category: "erc20", value: 100, tokenAddress: TOKEN, asset: "MOON" }),
    ];

    const trades = buildTradesFromTransfers(WALLET, "bnb", transfers, null, noopLaunchpad);

    expect(trades).toHaveLength(0);
  });

  it("returns trades sorted by timestamp ascending", () => {
    const transfers: AssetTransfer[] = [
      transfer({ hash: "0x6", from: WALLET, to: ROUTER, category: "external", value: 1, blockTimestamp: "2026-02-01T00:00:00.000Z" }),
      transfer({ hash: "0x6", from: ROUTER, to: WALLET, category: "erc20", value: 100, tokenAddress: TOKEN, asset: "A", blockTimestamp: "2026-02-01T00:00:00.000Z" }),
      transfer({ hash: "0x7", from: WALLET, to: ROUTER, category: "external", value: 1, blockTimestamp: "2026-01-01T00:00:00.000Z" }),
      transfer({ hash: "0x7", from: ROUTER, to: WALLET, category: "erc20", value: 100, tokenAddress: TOKEN, asset: "A", blockTimestamp: "2026-01-01T00:00:00.000Z" }),
    ];

    const trades = buildTradesFromTransfers(WALLET, "bnb", transfers, 600, noopLaunchpad);

    expect(trades.map((t) => t.txSignature)).toEqual(["0x7", "0x6"]);
  });
});
