import type { Trade } from "../../pnl-engine/types.js";
import type { HeliusEnhancedTransaction } from "./heliusClient.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const LAMPORTS_PER_SOL = 1_000_000_000;
const DUST_QTY = 1e-9;

/**
 * Helius transaction `type` values that represent a real priced fill.
 * `SWAP` is the obvious one; `CREATE` also belongs here because pump.fun's
 * "launch token + make the initial dev buy" instruction is classified as
 * `CREATE`, not `SWAP`, despite being a genuine priced buy with the same
 * accountData shape (confirmed against real mainnet transactions during
 * validation -- see providers/solana/heliusClient.ts's doc comment on
 * `fetchRecentSwaps`). Everything else (plain transfers, `UNKNOWN`, NFT
 * activity, etc.) is not a priced trade and is skipped.
 */
const TRADEABLE_TX_TYPES = new Set(["SWAP", "CREATE"]);

/**
 * Turns Helius's Enhanced Transaction shape into pnl-engine `Trade[]` for
 * one wallet.
 *
 * APPROACH: rather than walking each transaction's `tokenTransfers` hop by
 * hop (fragile for Jupiter-routed, multi-hop swaps -- verified against real
 * mainnet transactions during this work: the intermediate router/PDA
 * account shows up as the nominal sender/receiver on individual transfer
 * legs, not the wallet itself), this reads the wallet's *net* balance
 * change per mint straight out of Helius's `accountData`: the wallet's own
 * row's `nativeBalanceChange` for SOL, plus a scan of every `accountData`
 * row's `tokenBalanceChanges` for entries owned by this wallet, for every
 * other mint. That reflects the wallet's actual end-to-end balance delta
 * for the whole transaction regardless of how many hops the route took --
 * the same technique general-purpose portfolio/PnL trackers use for this
 * exact reason.
 *
 * KNOWN LIMITATION 1 -- quote-asset coverage: only SOL, USDC, and USDT are
 * recognized as "quote" legs. A token<->token swap with neither (rare for
 * pump.fun-style memecoin trading, which is almost always vs. SOL) can't be
 * priced from this transaction alone and is skipped rather than guessed at.
 *
 * KNOWN LIMITATION 2 -- historical SOL price: SOL-denominated fills are
 * priced using the *current* SOL/USD price (passed in as `solUsdPrice`,
 * from Jupiter), not the historical price at the fill's own block time.
 * Jupiter's price API only serves current prices, and a proper historical
 * backfill (a paid data source, or reconstructing price from historical
 * SOL/USDC pool reserves block-by-block) was out of scope for this pass.
 * This skews *realized* PnL for old trades if SOL's price has moved a lot
 * since; unrealized PnL (current price on both legs) is unaffected. See the
 * Item 2 hand-off report for how much this mattered on the wallets checked
 * by hand.
 *
 * KNOWN LIMITATION 3 -- multi-token-leg transactions: if a single
 * transaction nets out more than one non-quote mint for the wallet (rare --
 * seen in some aggregator routes), the quote value is split evenly across
 * those legs rather than priced individually, since there's no reliable way
 * to attribute an aggregate quote amount to each leg from this data alone.
 */
export function mapHeliusSwapsToTrades(
  wallet: string,
  transactions: HeliusEnhancedTransaction[],
  solUsdPrice: number,
): Trade[] {
  const trades: Trade[] = [];

  for (const tx of transactions) {
    if (tx.transactionError) continue;
    if (!tx.signature || !Number.isFinite(tx.timestamp)) continue;
    if (!TRADEABLE_TX_TYPES.has(tx.type)) continue;

    let netSolLamports = 0;
    for (const acc of tx.accountData ?? []) {
      if (acc.account === wallet) {
        netSolLamports += acc.nativeBalanceChange;
      }
    }

    const netByMint = new Map<string, number>();
    for (const acc of tx.accountData ?? []) {
      for (const change of acc.tokenBalanceChanges ?? []) {
        if (change.userAccount !== wallet) continue;
        const decimals = change.rawTokenAmount?.decimals;
        const raw = Number(change.rawTokenAmount?.tokenAmount);
        if (!Number.isFinite(raw) || !Number.isFinite(decimals)) continue;
        const qty = raw / 10 ** decimals;
        netByMint.set(change.mint, (netByMint.get(change.mint) ?? 0) + qty);
      }
    }

    let quoteUsd = (netSolLamports / LAMPORTS_PER_SOL) * solUsdPrice;

    const wsolDelta = netByMint.get(WSOL_MINT);
    if (wsolDelta) quoteUsd += wsolDelta * solUsdPrice;
    netByMint.delete(WSOL_MINT);

    const usdcDelta = netByMint.get(USDC_MINT) ?? 0;
    const usdtDelta = netByMint.get(USDT_MINT) ?? 0;
    quoteUsd += usdcDelta + usdtDelta;
    netByMint.delete(USDC_MINT);
    netByMint.delete(USDT_MINT);

    const baseEntries = [...netByMint.entries()].filter(
      ([, qty]) => Math.abs(qty) > DUST_QTY,
    );
    if (baseEntries.length === 0) continue;
    if (Math.abs(quoteUsd) < 1e-9) continue; // no priceable quote leg -- see limitation 1

    const perLegQuoteUsd = quoteUsd / baseEntries.length;
    const isoTimestamp = new Date(tx.timestamp * 1000).toISOString();
    const preGraduation = tx.source === "PUMP_FUN";

    for (const [mint, netQty] of baseEntries) {
      const side: Trade["side"] = netQty > 0 ? "buy" : "sell";
      const quantity = Math.abs(netQty);
      const priceUsd = Math.abs(perLegQuoteUsd) / quantity;
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

      trades.push({
        txSignature: tx.signature,
        chain: "solana",
        wallet,
        tokenMintOrAddress: mint,
        side,
        quantity,
        priceUsd,
        timestamp: isoTimestamp,
        preGraduation,
      });
    }
  }

  return trades;
}
