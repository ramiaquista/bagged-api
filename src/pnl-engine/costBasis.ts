import type { CostBasisResult, Trade } from "./types.js";

/**
 * Computes running cost basis and realized PnL for a sequence of trades in
 * one token, reconciling the bonding-curve -> AMM pricing transition.
 *
 * Method: weighted-average cost (not FIFO/LIFO lot tracking). Chosen
 * because bonding-curve launches typically produce many small partial buys
 * in a short window, and FIFO lot bookkeeping adds real complexity for no
 * accuracy gain on a *full* exit (both methods agree there) while
 * weighted-average is also the standard simplification most portfolio
 * trackers use for *partial* exits. If a future requirement needs
 * FIFO/lot-level tax reporting, that should be a separate function layered
 * on top rather than a change to this one's contract (see NEXT_STEPS.md
 * item 2 / the hand-off report for the fuller reasoning).
 *
 * "Reconciling bonding-curve -> AMM" does not require special-casing the
 * graduation boundary *here*. Each `Trade.priceUsd` is expected to already
 * be a real fill price computed by the caller from the venue-appropriate
 * on-chain data (bonding-curve reserve deltas pre-graduation, pool deltas
 * post-graduation -- see providers/solana/mapTrades.ts). Once every fill is
 * priced in USD, a plain running weighted-average walk is graduation-
 * agnostic by construction: there's nothing to reconcile because both
 * regimes feed the exact same (timestamp, side, quantity, priceUsd) shape.
 */
export function computeCostBasis(trades: Trade[]): CostBasisResult {
  const sorted = [...trades].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let quantityHeld = 0;
  let costBasisUsd = 0;
  let realizedPnlUsd = 0;

  // pump.fun-style memecoins routinely have supplies in the hundreds of
  // millions to billions of units. A fixed absolute dust threshold (e.g.
  // "< 1e-9 units") that works fine for a token priced in whole units is
  // meaningless at that scale -- float64 subtraction over a handful of
  // large buys/sells can leave residual "dust" many orders of magnitude
  // above 1e-9 after a wallet has fully exited a position. Track the
  // largest quantity/cost-basis actually held at any point and clamp
  // final residuals *relative* to that scale instead, so a fully-exited
  // 150-million-supply token doesn't show up as an "open position" of
  // 0.0003 units worth $0.00. (Found via hand-validation against real
  // wallets -- see the Item 2 hand-off report.)
  let maxQuantitySeen = 0;
  let maxCostBasisSeen = 0;

  for (const trade of sorted) {
    if (!(trade.quantity > 0) || !Number.isFinite(trade.priceUsd) || trade.priceUsd < 0) {
      continue;
    }

    if (trade.side === "buy") {
      quantityHeld += trade.quantity;
      costBasisUsd += trade.quantity * trade.priceUsd;
      maxQuantitySeen = Math.max(maxQuantitySeen, quantityHeld);
      maxCostBasisSeen = Math.max(maxCostBasisSeen, costBasisUsd);
      continue;
    }

    // side === "sell"
    const avgCostPerUnit = quantityHeld > 0 ? costBasisUsd / quantityHeld : 0;
    const soldQty = Math.min(trade.quantity, quantityHeld);
    const unmatchedQty = trade.quantity - soldQty;

    realizedPnlUsd += soldQty * (trade.priceUsd - avgCostPerUnit);
    costBasisUsd -= soldQty * avgCostPerUnit;
    quantityHeld -= soldQty;

    // Selling more than the fetched history shows as held (tokens acquired
    // before the indexed window, via airdrop, or transferred in from
    // another wallet) still landed real USD in the wallet -- book it as
    // zero-cost-basis proceeds instead of silently dropping it.
    if (unmatchedQty > 0) {
      realizedPnlUsd += unmatchedQty * trade.priceUsd;
    }
  }

  // Clamp float dust from repeated division/subtraction, relative to the
  // largest balance actually held (falling back to a small absolute floor
  // for tokens that were only ever held in tiny quantities to begin with).
  const quantityDustFloor = Math.max(maxQuantitySeen * 1e-6, 1e-9);
  const costBasisDustFloor = Math.max(maxCostBasisSeen * 1e-6, 1e-6);
  if (Math.abs(quantityHeld) < quantityDustFloor) quantityHeld = 0;
  if (Math.abs(costBasisUsd) < costBasisDustFloor) costBasisUsd = 0;

  return { quantityHeld, costBasisUsd, realizedPnlUsd };
}
