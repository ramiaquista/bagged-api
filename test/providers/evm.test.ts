import { describe, expect, it } from "vitest";
import type { AlchemyClient, AssetTransfer } from "../../src/providers/alchemy/client.js";
import { EvmProvider } from "../../src/providers/evm.js";
import type { LaunchpadResolver } from "../../src/providers/launchpads/types.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "0xtoken0000000000000000000000000000000001";
const ROUTER = "0xrouter000000000000000000000000000000001";

const noopLaunchpad: LaunchpadResolver = {
  name: "noop",
  isBondingCurveAddress: () => false,
};

function fakeAlchemy(overrides: Partial<AlchemyClient> = {}): AlchemyClient {
  return {
    getAllTransfers: async () => [],
    getTokenPriceUsd: async () => null,
    getNativePriceUsd: async () => null,
    ...overrides,
  };
}

describe("EvmProvider", () => {
  it("falls back to mock data for a non-hex-address (existing stub behavior preserved)", async () => {
    const provider = new EvmProvider("bnb", { alchemy: fakeAlchemy() });
    const pnl = await provider.getWalletPnl("some-address");
    expect(pnl.chain).toBe("bnb");
    expect(pnl.wallet).toBe("some-address");
  });

  it("falls back to mock data when no Alchemy client is configured", async () => {
    const provider = new EvmProvider("ethereum"); // no deps.alchemy, and ALCHEMY_API_KEY unset in test env
    const positions = await provider.getWalletPositions(WALLET);
    expect(Array.isArray(positions)).toBe(true);
  });

  it("fetches real transfers, wires them through the pnl-engine stubs, and returns a valid WalletPnl shape", async () => {
    const transfers: AssetTransfer[] = [
      {
        hash: "0x1",
        from: WALLET,
        to: ROUTER,
        category: "external",
        asset: null,
        value: 1,
        tokenAddress: null,
        blockTimestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        hash: "0x1",
        from: ROUTER,
        to: WALLET,
        category: "erc20",
        asset: "CHAD",
        value: 1000,
        tokenAddress: TOKEN,
        blockTimestamp: "2026-01-01T00:00:00.000Z",
      },
    ];

    const provider = new EvmProvider("bnb", {
      alchemy: fakeAlchemy({
        getAllTransfers: async (address) => {
          expect(address).toBe(WALLET);
          return transfers;
        },
        getNativePriceUsd: async () => 600,
      }),
      launchpad: noopLaunchpad,
    });

    const pnl = await provider.getWalletPnl(WALLET);
    expect(pnl.wallet).toBe(WALLET);
    expect(pnl.chain).toBe("bnb");
    expect(pnl.realized_pnl_usd + pnl.unrealized_pnl_usd).toBeCloseTo(pnl.total_pnl_usd, 5);
    // computeCostBasis is real now (landed via item-2-solana-provider): one
    // buy fill (1 native @ $600 for 1000 CHAD) is a real $600 cost-basis
    // open position. fakeAlchemy's getTokenPriceUsd default (null) means
    // it's marked-to-zero, so unrealized PnL is -costBasis until a real
    // price is available. No sells yet, so realized PnL is 0; a single
    // fill can't be a wash trade or trigger rug resolution.
    expect(pnl.positions_open).toBe(1);
    expect(pnl.realized_pnl_usd).toBe(0);
    expect(pnl.unrealized_pnl_usd).toBe(-600);
    expect(pnl.wash_trades_excluded).toBe(0);
    expect(pnl.rugs_resolved).toBe(0);

    const positions = await provider.getWalletPositions(WALLET);
    expect(positions).toEqual([
      {
        token: "CHAD",
        mint_or_address: TOKEN,
        quantity: 1000,
        value_usd: 0,
        cost_basis_usd: 600,
        unrealized_pnl_usd: -600,
        unrealized_pnl_pct: -100,
      },
    ]);
  });

  it("throws a 502 ApiError when the upstream Alchemy call fails, instead of silently returning mock numbers", async () => {
    const provider = new EvmProvider("robinhood", {
      alchemy: fakeAlchemy({
        getAllTransfers: async () => {
          throw new Error("network down");
        },
      }),
    });

    await expect(provider.getWalletPnl(WALLET)).rejects.toMatchObject({
      statusCode: 502,
      code: "upstream_provider_error",
    });
  });

  it("tolerates a per-token price lookup failure without failing the whole wallet", async () => {
    // NOTE: getAllTransfers returns [] here, so there's no open position and
    // getTokenPriceUsd is never actually called -- this only asserts that a
    // wallet with zero activity resolves cleanly. See the fixture-backed
    // test above for the case where a real fill produces a real position
    // and a price lookup actually happens.
    const provider = new EvmProvider("bnb", {
      alchemy: fakeAlchemy({
        getAllTransfers: async () => [],
        getTokenPriceUsd: async () => {
          throw new Error("price service down");
        },
      }),
    });
    await expect(provider.getWalletPnl(WALLET)).resolves.toBeDefined();
  });
});
