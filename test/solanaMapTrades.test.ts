import { describe, expect, it } from "vitest";
import type { HeliusEnhancedTransaction } from "../src/providers/solana/heliusClient.js";
import {
  mapHeliusSwapsToTrades,
  USDC_MINT,
  WSOL_MINT,
} from "../src/providers/solana/mapTrades.js";

const WALLET = "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s";
const PUMP_MINT = "5aZzfi1fhbwqU9BRkMvHZTHAaTtrD1Fhi8aa5T7Cpump";
const SOL_USD = 100;

function baseTx(overrides: Partial<HeliusEnhancedTransaction>): HeliusEnhancedTransaction {
  return {
    signature: "sig1",
    type: "SWAP",
    source: "PUMP_FUN",
    timestamp: 1_788_287_042,
    feePayer: "someRelayer",
    tokenTransfers: [],
    nativeTransfers: [],
    accountData: [],
    transactionError: null,
    ...overrides,
  };
}

describe("mapHeliusSwapsToTrades", () => {
  it("maps a pump.fun bonding-curve SELL (native SOL leg) into a sell Trade", () => {
    // Shape modeled on a real mainnet Helius Enhanced Transaction response
    // (captured while validating against BwWK17cb... during this work):
    // the wallet's own accountData row shows the native SOL it received,
    // and a *different* accountData row's tokenBalanceChanges (keyed by
    // token account, not owner) records the wallet's token outflow.
    const tx = baseTx({
      signature: "sell-sig",
      source: "PUMP_FUN",
      accountData: [
        { account: WALLET, nativeBalanceChange: 31_540_005, tokenBalanceChanges: [] },
        {
          account: "someTokenAccount",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: PUMP_MINT,
              rawTokenAmount: { tokenAmount: "-2495397359097", decimals: 6 },
            },
          ],
        },
      ],
    });

    const trades = mapHeliusSwapsToTrades(WALLET, [tx], SOL_USD);
    expect(trades).toHaveLength(1);
    const [t] = trades;
    expect(t?.side).toBe("sell");
    expect(t?.tokenMintOrAddress).toBe(PUMP_MINT);
    expect(t?.quantity).toBeCloseTo(2_495_397.359097, 3);
    // quoteUsd = 0.031540005 SOL * $100 = $3.1540005
    expect(t?.priceUsd).toBeCloseTo(3.1540005 / 2_495_397.359097, 10);
    expect(t?.preGraduation).toBe(true);
    expect(t?.chain).toBe("solana");
    expect(t?.wallet).toBe(WALLET);
  });

  it("maps a pump.fun bonding-curve BUY into a buy Trade", () => {
    const tx = baseTx({
      signature: "buy-sig",
      source: "PUMP_FUN",
      accountData: [
        { account: WALLET, nativeBalanceChange: -206_568_346, tokenBalanceChanges: [] },
        {
          account: "someTokenAccount",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: PUMP_MINT,
              rawTokenAmount: { tokenAmount: "7499275903014", decimals: 6 },
            },
          ],
        },
      ],
    });

    const trades = mapHeliusSwapsToTrades(WALLET, [tx], SOL_USD);
    expect(trades).toHaveLength(1);
    const [t] = trades;
    expect(t?.side).toBe("buy");
    expect(t?.quantity).toBeCloseTo(7_499_275.903014, 3);
    expect(t?.priceUsd).toBeGreaterThan(0);
    expect(t?.preGraduation).toBe(true);
  });

  it("marks a graduated-pool swap (non PUMP_FUN source) as not pre-graduation", () => {
    const tx = baseTx({
      signature: "raydium-sig",
      source: "RAYDIUM",
      accountData: [
        { account: WALLET, nativeBalanceChange: -100_000_000, tokenBalanceChanges: [] },
        {
          account: "someTokenAccount",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: PUMP_MINT,
              rawTokenAmount: { tokenAmount: "500000000", decimals: 6 },
            },
          ],
        },
      ],
    });

    const trades = mapHeliusSwapsToTrades(WALLET, [tx], SOL_USD);
    expect(trades).toHaveLength(1);
    expect(trades[0]?.preGraduation).toBe(false);
  });

  it("prices a USDC-quoted swap at 1:1 USD without needing a SOL price", () => {
    const tx = baseTx({
      signature: "usdc-sig",
      source: "RAYDIUM",
      accountData: [
        {
          account: "walletUsdcAccount",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: USDC_MINT,
              rawTokenAmount: { tokenAmount: "-50000000", decimals: 6 },
            },
          ],
        },
        {
          account: "walletTokenAccount",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: PUMP_MINT,
              rawTokenAmount: { tokenAmount: "1000000000", decimals: 6 },
            },
          ],
        },
      ],
    });

    const trades = mapHeliusSwapsToTrades(WALLET, [tx], 0 /* SOL price irrelevant here */);
    expect(trades).toHaveLength(1);
    const [t] = trades;
    expect(t?.side).toBe("buy");
    expect(t?.quantity).toBeCloseTo(1000, 6);
    expect(t?.priceUsd).toBeCloseTo(50 / 1000, 8);
  });

  it("skips a transaction with no recognizable quote leg (token<->token, no SOL/stable)", () => {
    const tx = baseTx({
      signature: "no-quote-sig",
      accountData: [
        {
          account: "acc1",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: "OTHER_MINT",
              rawTokenAmount: { tokenAmount: "-1000000", decimals: 6 },
            },
          ],
        },
        {
          account: "acc2",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: PUMP_MINT,
              rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
            },
          ],
        },
      ],
    });

    const trades = mapHeliusSwapsToTrades(WALLET, [tx], SOL_USD);
    expect(trades).toHaveLength(0);
  });

  it("treats a pump.fun CREATE (launch + initial dev buy) as a priced buy trade", () => {
    // Real-world gap found during hand-validation: pump.fun's "launch token
    // + make the initial dev buy" instruction is classified by Helius as
    // type "CREATE", not "SWAP", despite being a genuine priced buy with
    // the same accountData shape. Skipping it would make every later sell
    // of a self-launched token look like 100%-margin profit.
    const tx = baseTx({
      signature: "create-sig",
      type: "CREATE",
      source: "PUMP_FUN",
      accountData: [
        { account: WALLET, nativeBalanceChange: -5_029_600_000, tokenBalanceChanges: [] },
        {
          account: "creatorTokenAcct",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: PUMP_MINT,
              rawTokenAmount: { tokenAmount: "151660777334045", decimals: 6 },
            },
          ],
        },
      ],
    });

    const trades = mapHeliusSwapsToTrades(WALLET, [tx], SOL_USD);
    expect(trades).toHaveLength(1);
    expect(trades[0]?.side).toBe("buy");
    expect(trades[0]?.preGraduation).toBe(true);
  });

  it("skips non-tradeable transaction types (plain transfers, UNKNOWN)", () => {
    const transferTx = baseTx({
      signature: "transfer-sig",
      type: "TRANSFER",
      source: "SYSTEM_PROGRAM",
      accountData: [{ account: WALLET, nativeBalanceChange: 911_900_000, tokenBalanceChanges: [] }],
    });
    const unknownTx = baseTx({
      signature: "unknown-sig",
      type: "UNKNOWN",
      accountData: [{ account: WALLET, nativeBalanceChange: 49_800_000, tokenBalanceChanges: [] }],
    });

    expect(mapHeliusSwapsToTrades(WALLET, [transferTx, unknownTx], SOL_USD)).toHaveLength(0);
  });

  it("skips failed transactions", () => {
    const tx = baseTx({ transactionError: { InstructionError: [0, "Custom"] } });
    expect(mapHeliusSwapsToTrades(WALLET, [tx], SOL_USD)).toHaveLength(0);
  });

  it("ignores balance changes belonging to other accounts", () => {
    const tx = baseTx({
      accountData: [
        { account: "someoneElse", nativeBalanceChange: 999_999_999, tokenBalanceChanges: [] },
        {
          account: "acc2",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: "someoneElse",
              mint: PUMP_MINT,
              rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
            },
          ],
        },
      ],
    });
    expect(mapHeliusSwapsToTrades(WALLET, [tx], SOL_USD)).toHaveLength(0);
  });

  it("folds a wrapped-SOL token leg into the SOL quote value", () => {
    const tx = baseTx({
      accountData: [
        {
          account: "walletWsolAccount",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: WSOL_MINT,
              rawTokenAmount: { tokenAmount: "-1000000000", decimals: 9 },
            },
          ],
        },
        {
          account: "walletTokenAccount",
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              userAccount: WALLET,
              mint: PUMP_MINT,
              rawTokenAmount: { tokenAmount: "2000000", decimals: 6 },
            },
          ],
        },
      ],
    });

    const trades = mapHeliusSwapsToTrades(WALLET, [tx], SOL_USD);
    expect(trades).toHaveLength(1);
    // spent 1 wrapped SOL @ $100 for 2 tokens => $50/token
    expect(trades[0]?.priceUsd).toBeCloseTo(50, 6);
  });
});
