import type { CostBasisResult, Trade } from "./types.js";

/**
 * Computes running cost basis and realized PnL for a sequence of trades in
 * one token, reconciling the bonding-curve -> AMM pricing transition.
 *
 * STATUS: stub. Real implementation needs, per chain:
 *   - pump.fun / four.meme bonding-curve state reads for pre-graduation fills
 *     (their pricing curve, not a pool price, sets cost basis)
 *   - a weighted-average (or FIFO — TBD) cost-basis method applied across the
 *     graduation boundary without a discontinuity
 *   - see docs/spec section 6 ("Architecture & build vs. buy") for the fuller
 *     writeup of why this is the highest-risk piece of the engine.
 *
 * For now this returns a plausible-shaped zero result so callers can be
 * wired up before the real math exists.
 */
export function computeCostBasis(trades: Trade[]): CostBasisResult {
  void trades;
  return { quantityHeld: 0, costBasisUsd: 0, realizedPnlUsd: 0 };
}
