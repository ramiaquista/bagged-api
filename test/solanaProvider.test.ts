import { beforeEach, describe, expect, it, vi } from "vitest";

// SolanaProvider is wired to real Helius/Jupiter clients (see
// src/providers/solana.ts) -- these tests replace those clients and the
// config module with fixtures so the pnl-engine wiring can be exercised
// deterministically, offline, without depending on a live API key or
// network access. (The existing route-level tests in test/wallet.test.ts
// and test/portfolio.test.ts exercise the same provider *without* mocking
// anything -- they rely on HELIUS_API_KEY being unset in the test
// environment, which makes SolanaProvider degrade to a zeroed-out result;
// see that file's comments and the Item 2 hand-off report.)

const WALLET = "TestWallet11111111111111111111111111111111";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const WINNER_MINT = "WinnerMint111111111111111111111111111111111";
const OPEN_MINT = "OpenMint1111111111111111111111111111111111";
const RUGGED_MINT = "RuggedMint111111111111111111111111111111111";

vi.mock("../src/config.js", () => ({
  config: {
    PORT: 8080,
    LOG_LEVEL: "info",
    API_KEY_SECRET: "test",
    ALLOW_DEV_KEY: true,
    HELIUS_API_KEY: "fake-helius-key",
    ALCHEMY_API_KEY: undefined,
    JUPITER_API_BASE_URL: "https://lite-api.jup.ag",
  },
}));

vi.mock("../src/providers/solana/heliusClient.js", () => ({
  fetchRecentSwaps: vi.fn(),
  fetchAssetMetadata: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../src/providers/solana/jupiterClient.js", () => ({
  fetchUsdPrices: vi.fn(),
}));

describe("SolanaProvider (mocked Helius/Jupiter)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("computes realized + unrealized PnL, wash-trade exclusion, and rug resolution together", async () => {
    const heliusClient = await import("../src/providers/solana/heliusClient.js");
    const jupiterClient = await import("../src/providers/solana/jupiterClient.js");
    const { SolanaProvider } = await import("../src/providers/solana.js");

    // Fixture trade history across three tokens:
    //  - WINNER_MINT: fully exited for a realized profit.
    //  - OPEN_MINT: still held, priced by a live Jupiter quote (unrealized gain).
    //  - RUGGED_MINT: still held, but Jupiter has no live price -> forced loss.
    // We bypass mapHeliusSwapsToTrades (already covered by
    // test/solanaMapTrades.test.ts) by mocking fetchRecentSwaps to return
    // raw transactions, but since mapping is internal to the provider, we
    // instead feed pre-shaped Helius transactions that map cleanly.
    vi.mocked(heliusClient.fetchRecentSwaps).mockResolvedValue([
      {
        signature: "winner-buy",
        type: "SWAP",
        source: "PUMP_FUN",
        timestamp: 1_700_000_000,
        feePayer: "relayer",
        tokenTransfers: [],
        nativeTransfers: [],
        transactionError: null,
        accountData: [
          { account: WALLET, nativeBalanceChange: -1_000_000_000, tokenBalanceChanges: [] },
          {
            account: "winnerTokenAcct",
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: WALLET,
                mint: WINNER_MINT,
                rawTokenAmount: { tokenAmount: "1000000000", decimals: 6 },
              },
            ],
          },
        ],
      },
      {
        signature: "winner-sell",
        type: "SWAP",
        source: "RAYDIUM",
        timestamp: 1_700_001_000,
        feePayer: "relayer",
        tokenTransfers: [],
        nativeTransfers: [],
        transactionError: null,
        accountData: [
          { account: WALLET, nativeBalanceChange: 3_000_000_000, tokenBalanceChanges: [] },
          {
            account: "winnerTokenAcct",
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: WALLET,
                mint: WINNER_MINT,
                rawTokenAmount: { tokenAmount: "-1000000000", decimals: 6 },
              },
            ],
          },
        ],
      },
      {
        signature: "open-buy",
        type: "SWAP",
        source: "PUMP_FUN",
        timestamp: 1_700_002_000,
        feePayer: "relayer",
        tokenTransfers: [],
        nativeTransfers: [],
        transactionError: null,
        accountData: [
          { account: WALLET, nativeBalanceChange: -1_000_000_000, tokenBalanceChanges: [] },
          {
            account: "openTokenAcct",
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: WALLET,
                mint: OPEN_MINT,
                rawTokenAmount: { tokenAmount: "500000000", decimals: 6 },
              },
            ],
          },
        ],
      },
      {
        signature: "rugged-buy",
        type: "SWAP",
        source: "PUMP_FUN",
        timestamp: 1_700_003_000,
        feePayer: "relayer",
        tokenTransfers: [],
        nativeTransfers: [],
        transactionError: null,
        accountData: [
          { account: WALLET, nativeBalanceChange: -2_000_000_000, tokenBalanceChanges: [] },
          {
            account: "ruggedTokenAcct",
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: WALLET,
                mint: RUGGED_MINT,
                rawTokenAmount: { tokenAmount: "1000000000", decimals: 6 },
              },
            ],
          },
        ],
      },
    ]);

    vi.mocked(jupiterClient.fetchUsdPrices).mockImplementation(async (mints: string[]) => {
      const prices = new Map<string, number>();
      if (mints.includes(WSOL_MINT)) prices.set(WSOL_MINT, 100);
      // OPEN_MINT has a live price (current value higher than cost basis);
      // RUGGED_MINT deliberately has no entry -> "no live price" signal.
      if (mints.includes(OPEN_MINT)) prices.set(OPEN_MINT, 0.5);
      return prices;
    });

    const provider = new SolanaProvider();
    const pnl = await provider.getWalletPnl(WALLET);

    expect(pnl.wallet).toBe(WALLET);
    expect(pnl.chain).toBe("solana");
    // winner: bought 1000 tokens for 1 SOL ($100), sold for 3 SOL ($300) -> +$200 realized
    // rugged: bought 1000 tokens for 2 SOL ($200), no live price -> -$200 realized (forced loss)
    expect(pnl.realized_pnl_usd).toBeCloseTo(0, 1); // +200 - 200
    // open: bought 500 tokens for 1 SOL ($100 cost), now worth 500 * $400... wait price is per-mint USD price directly (Jupiter quotes are already per-unit USD)
    expect(pnl.unrealized_pnl_usd).toBeGreaterThan(0);
    expect(pnl.positions_open).toBe(1);
    expect(pnl.rugs_resolved).toBe(1);
    expect(pnl.total_pnl_usd).toBeCloseTo(pnl.realized_pnl_usd + pnl.unrealized_pnl_usd, 6);
  });

  it("returns a zeroed-out result when Helius returns no swap history", async () => {
    const heliusClient = await import("../src/providers/solana/heliusClient.js");
    const jupiterClient = await import("../src/providers/solana/jupiterClient.js");
    const { SolanaProvider } = await import("../src/providers/solana.js");

    vi.mocked(heliusClient.fetchRecentSwaps).mockResolvedValue([]);
    vi.mocked(jupiterClient.fetchUsdPrices).mockResolvedValue(new Map());

    const provider = new SolanaProvider();
    const pnl = await provider.getWalletPnl("some-garbage-address");

    expect(pnl.realized_pnl_usd).toBe(0);
    expect(pnl.unrealized_pnl_usd).toBe(0);
    expect(pnl.total_pnl_usd).toBe(0);
    expect(pnl.positions_open).toBe(0);
    expect(pnl.rugs_resolved).toBe(0);

    const positions = await provider.getWalletPositions("some-garbage-address");
    expect(positions).toEqual([]);
  });

  it("returns a zeroed-out result when the Helius call throws", async () => {
    const heliusClient = await import("../src/providers/solana/heliusClient.js");
    const { SolanaProvider } = await import("../src/providers/solana.js");

    vi.mocked(heliusClient.fetchRecentSwaps).mockRejectedValue(new Error("network error"));

    const provider = new SolanaProvider();
    const pnl = await provider.getWalletPnl(WALLET);
    expect(pnl.total_pnl_usd).toBe(0);
  });

  it("excludes wash trades from realized PnL via the same pipeline", async () => {
    const heliusClient = await import("../src/providers/solana/heliusClient.js");
    const jupiterClient = await import("../src/providers/solana/jupiterClient.js");
    const { SolanaProvider } = await import("../src/providers/solana.js");

    // Buy and sell the same size within the wash window -- should be
    // excluded rather than counted as a realized gain/loss.
    vi.mocked(heliusClient.fetchRecentSwaps).mockResolvedValue([
      {
        signature: "wash-buy",
        type: "SWAP",
        source: "PUMP_FUN",
        timestamp: 1_700_000_000,
        feePayer: "relayer",
        tokenTransfers: [],
        nativeTransfers: [],
        transactionError: null,
        accountData: [
          { account: WALLET, nativeBalanceChange: -1_000_000_000, tokenBalanceChanges: [] },
          {
            account: "washTokenAcct",
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: WALLET,
                mint: WINNER_MINT,
                rawTokenAmount: { tokenAmount: "1000000000", decimals: 6 },
              },
            ],
          },
        ],
      },
      {
        signature: "wash-sell",
        type: "SWAP",
        source: "PUMP_FUN",
        timestamp: 1_700_000_001, // 1 second later, well within the wash window
        feePayer: "relayer",
        tokenTransfers: [],
        nativeTransfers: [],
        transactionError: null,
        accountData: [
          { account: WALLET, nativeBalanceChange: 1_000_000_000, tokenBalanceChanges: [] },
          {
            account: "washTokenAcct",
            nativeBalanceChange: 0,
            tokenBalanceChanges: [
              {
                userAccount: WALLET,
                mint: WINNER_MINT,
                rawTokenAmount: { tokenAmount: "-1000000000", decimals: 6 },
              },
            ],
          },
        ],
      },
    ]);
    vi.mocked(jupiterClient.fetchUsdPrices).mockImplementation(async (mints: string[]) => {
      const prices = new Map<string, number>();
      if (mints.includes(WSOL_MINT)) prices.set(WSOL_MINT, 100);
      return prices;
    });

    const provider = new SolanaProvider();
    const pnl = await provider.getWalletPnl(WALLET);
    expect(pnl.wash_trades_excluded).toBe(2);
    expect(pnl.realized_pnl_usd).toBe(0);
    expect(pnl.total_pnl_usd).toBe(0);
  });
});
