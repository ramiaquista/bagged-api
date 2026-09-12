import type { Trade } from "../../pnl-engine/types.js";
import { nearestSolPrice, type PricePoint } from "./binanceClient.js";
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
 * HISTORICAL SOL PRICE: SOL-denominated fills are priced from
 * `historicalPrices` (Binance SOLUSDT klines, see binanceClient.ts) at each
 * fill's own block time, nearest-match -- not the current price. Previously
 * this used one flat *current* SOL/USD snapshot for every fill regardless
 * of age, which silently priced week-old trades at today's rate. Falls back
 * to `currentSolUsdPrice` per fill only when no historical series was
 * supplied, or it came back empty (Binance unreachable) -- unrealized PnL
 * (current price on both legs) was never affected by this either way.
 *
 * KNOWN LIMITATION 3 -- multi-token-leg transactions: if a single
 * transaction nets out more than one non-quote mint for the wallet (rare --
 * seen in some aggregator routes), the quote value is split evenly across
 * those legs rather than priced individually, since there's no reliable way
 * to attribute an aggregate quote amount to each leg from this data alone.
 *
 * PLAIN TRANSFERS: a `TRANSFER`-type transaction (Helius's classification
 * for an ordinary wallet-to-wallet SPL transfer, not a swap) that moves a
 * non-quote token OUT of the wallet is recorded as a `transfer_out` Trade
 * (quantity only, $0 price -- see pnl-engine/costBasis.ts) rather than
 * silently dropped. Confirmed against a real wallet: a token bought in two
 * batches where only the first was later sold on-market -- the second,
 * small leftover was sent elsewhere via a plain transfer -- left that
 * leftover's cost basis stuck forever with no resolution, both overstating
 * quantityHeld (the tokens aren't there anymore) and, wherever a caller
 * computed realized PnL as proceeds-minus-total-bought instead of from this
 * engine's own running total, showing that leftover as a full loss it never
 * actually was.
 */
export function mapHeliusSwapsToTrades(
  wallet: string,
  transactions: HeliusEnhancedTransaction[],
  currentSolUsdPrice: number,
  historicalPrices: PricePoint[] = [],
): Trade[] {
  const trades: Trade[] = [];
  console.error(`[mapTrades] Processing ${transactions.length} txs, current SOL price=$${currentSolUsdPrice}, historical series has ${historicalPrices.length} points`);

  for (const tx of transactions) {
    if (tx.transactionError) continue;
    if (!tx.signature || !Number.isFinite(tx.timestamp)) continue;

    const isTradeable = TRADEABLE_TX_TYPES.has(tx.type);
    const isPlainTransfer = tx.type === "TRANSFER";
    if (!isTradeable && !isPlainTransfer) continue;

    const isoTimestamp = new Date(tx.timestamp * 1000).toISOString();

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

    if (isPlainTransfer) {
      // Quote assets moving between the user's own wallets aren't a
      // memecoin position -- this system doesn't track SOL/USDC/USDT
      // holdings as "positions", only what they bought with them.
      netByMint.delete(WSOL_MINT);
      netByMint.delete(USDC_MINT);
      netByMint.delete(USDT_MINT);

      for (const [mint, netQty] of netByMint) {
        if (netQty >= 0 || Math.abs(netQty) <= DUST_QTY) continue; // only outbound transfers -- see doc comment
        trades.push({
          txSignature: tx.signature,
          chain: "solana",
          wallet,
          tokenMintOrAddress: mint,
          side: "transfer_out",
          quantity: Math.abs(netQty),
          priceUsd: 0,
          timestamp: isoTimestamp,
          preGraduation: false,
        });
      }
      continue;
    }

    const solUsdPrice = nearestSolPrice(historicalPrices, tx.timestamp * 1000) ?? currentSolUsdPrice;

    let netSolLamports = 0;
    for (const acc of tx.accountData ?? []) {
      if (acc.account === wallet) {
        netSolLamports += acc.nativeBalanceChange;
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
    if (baseEntries.length === 0) {
      console.error(`[mapTrades] ${tx.type} ${tx.signature}: no base entries`);
      continue;
    }
    if (Math.abs(quoteUsd) < 1e-9) {
      console.error(`[mapTrades] ${tx.type} ${tx.signature}: quoteUsd too small (${quoteUsd})`);
      continue; // no priceable quote leg -- see limitation 1
    }

    const perLegQuoteUsd = quoteUsd / baseEntries.length;
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
