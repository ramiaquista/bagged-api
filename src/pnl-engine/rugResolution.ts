import type { RugResolutionResult, Trade } from "./types.js";

/** A token whose last observed fill price has collapsed to this fraction (or less) of its historical peak is treated as rugged. */
const PRICE_COLLAPSE_RATIO = 0.02;

/** Don't flag a rug off a single fill -- need at least one buy and one later data point to call a "collapse". */
const MIN_TRADES_FOR_SIGNAL = 2;

/**
 * Resolves positions in tokens that have gone to zero (rugged / honeypot /
 * liquidity pulled) to a clean realized loss instead of leaving them
 * "unpriced" forever.
 *
 * Signature intentionally stays trade-history-only (no live liquidity/quote
 * feed parameter), so this stays a pure, synchronous, easily-unit-tested
 * function: a token whose last observed fill price has collapsed to a small
 * fraction of its historical peak, while the wallet is still net holding a
 * nonzero quantity, is treated as rugged and force-resolved to a realized
 * loss equal to its remaining cost basis (i.e. $0 recovery).
 *
 * This is necessarily a heuristic from history alone -- it can't distinguish
 * "rugged" from "still trading, just way down" with full certainty the way
 * a live "no route on Jupiter" check could (that was the stub's original
 * aspiration, per this file's earlier comment). SolanaProvider layers that
 * stronger, live signal on top of this one before actually force-closing a
 * position in an API response -- treating "no live Jupiter price at all"
 * as an even more reliable rug signal than this function's price-history
 * heuristic alone. See providers/solana.ts.
 *
 * Groups trades by token internally, so it's safe to call this with either
 * one token's fills or a wallet's whole multi-token trade history.
 */
export function resolveRugs(trades: Trade[]): RugResolutionResult {
  const byToken = new Map<string, Trade[]>();
  for (const trade of trades) {
    const list = byToken.get(trade.tokenMintOrAddress);
    if (list) {
      list.push(trade);
    } else {
      byToken.set(trade.tokenMintOrAddress, [trade]);
    }
  }

  let resolvedCount = 0;
  let realizedLossUsd = 0;

  for (const list of byToken.values()) {
    if (list.length < MIN_TRADES_FOR_SIGNAL) continue;

    const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    let quantityHeld = 0;
    let costBasisUsd = 0;
    let peakPriceUsd = 0;
    // See costBasis.ts's identical note: memecoin supplies can be huge, so
    // dust after a full exit needs a scale-relative floor, not a fixed
    // absolute one.
    let maxQuantitySeen = 0;

    for (const trade of sorted) {
      if (!Number.isFinite(trade.priceUsd) || trade.priceUsd < 0) continue;
      if (trade.priceUsd > peakPriceUsd) peakPriceUsd = trade.priceUsd;

      if (trade.side === "buy") {
        quantityHeld += trade.quantity;
        costBasisUsd += trade.quantity * trade.priceUsd;
        maxQuantitySeen = Math.max(maxQuantitySeen, quantityHeld);
      } else {
        const avgCost = quantityHeld > 0 ? costBasisUsd / quantityHeld : 0;
        const soldQty = Math.min(trade.quantity, quantityHeld);
        costBasisUsd -= soldQty * avgCost;
        quantityHeld -= soldQty;
      }
    }

    const quantityDustFloor = Math.max(maxQuantitySeen * 1e-6, 1e-9);
    const lastTrade = sorted[sorted.length - 1];
    if (!lastTrade || quantityHeld <= quantityDustFloor || peakPriceUsd <= 0 || costBasisUsd <= 0) {
      continue;
    }

    const collapsed = lastTrade.priceUsd <= peakPriceUsd * PRICE_COLLAPSE_RATIO;
    if (!collapsed) continue;

    resolvedCount += 1;
    realizedLossUsd += costBasisUsd;
  }

  return { resolvedCount, realizedLossUsd };
}
