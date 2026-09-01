export * from "./types.js";
export { computeCostBasis } from "./costBasis.js";
export { filterWashTrades } from "./washTrade.js";
export { resolveRugs } from "./rugResolution.js";

/**
 * This module is the seam between "real trade history in" and "accurate PnL
 * out":
 *
 *   raw fills (Helius/Alchemy) -> filterWashTrades -> computeCostBasis
 *     (bonding-curve aware) -> resolveRugs -> WalletPnl
 *
 * `SolanaProvider` (see providers/solana.ts) is wired up to this pipeline as
 * of Item 2 in NEXT_STEPS.md — per-token: map raw Helius fills to `Trade[]`,
 * run `filterWashTrades`, then `computeCostBasis` on the clean trades, then
 * `resolveRugs` (plus a live-price check) to decide whether a residual
 * holding is an open position or a force-resolved loss. `EvmProvider`
 * (src/providers/evm.ts) still returns mock data and has not been wired up
 * to this pipeline yet — that's Item 3, being worked in a parallel branch
 * that depends on these same three exported function signatures staying
 * stable. See the Item 2 hand-off report for what's implemented vs.
 * approximated.
 */
