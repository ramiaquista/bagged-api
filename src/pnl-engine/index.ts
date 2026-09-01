export * from "./types.js";
export { computeCostBasis } from "./costBasis.js";
export { filterWashTrades } from "./washTrade.js";
export { resolveRugs } from "./rugResolution.js";

/**
 * This module is the seam between "real trade history in" and "accurate PnL
 * out." Right now nothing calls into it yet — src/providers/*.ts return
 * pre-computed mock PnL directly, standing in for what will eventually be:
 *
 *   raw fills (Helius/Alchemy) -> filterWashTrades -> computeCostBasis
 *     (bonding-curve aware) -> resolveRugs -> WalletPnl
 *
 * Wire that pipeline up here once a provider can supply real trade history.
 */
