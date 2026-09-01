import type { LaunchpadResolver } from "./types.js";

/**
 * hood.fun (Robinhood Chain) bonding-curve reconciliation.
 *
 * hood.fun ships a launchpad curve + Uniswap v3 migrator + ownerless
 * liquidity locker on Robinhood Chain (an Arbitrum-Orbit L2, chain ID 4663)
 * -- see https://hood.fun/whitepaper and
 * https://www.alchemy.com/overviews/launch-a-memecoin-on-robinhood-chain.
 *
 * KNOWN GAP (research gap, not a pnl-engine merge dependency -- follow up
 * directly, doesn't block on the other branch): Robinhood Chain went live
 * 2026-07-01 and hood.fun shortly after, and as of this implementation
 * neither hood.fun's site nor its whitepaper publish a contract address.
 * Robinhood Chain's block explorer (robinhoodchain.blockscout.com) sits
 * behind a bot-check that blocked automated lookup during this pass.
 * Populate BONDING_CURVE_ADDRESSES below with the real curve/factory
 * contract address(es) once confirmed on-chain (Robinscan or Blockscout's
 * verified-contracts list for hood.fun, or ask the hood.fun team directly)
 * -- this is the highest-priority chain per the spec's "ship Robinhood
 * first" ordering, so this is the first thing to close out here.
 *
 * Until populated, this resolver never tags a trade as pre-graduation on
 * Robinhood Chain: fills are treated as ordinary (already-AMM-priced)
 * trades. That's the conservative default (never wrongly flatters a
 * position), but it does mean pre-graduation/bonding-curve pricing on
 * Robinhood Chain is not yet reconciled -- see README.
 */
const BONDING_CURVE_ADDRESSES: ReadonlySet<string> = new Set([
  // e.g. "0x...".toLowerCase() -- add once verified on-chain.
]);

export const hoodFunResolver: LaunchpadResolver = {
  name: "hood.fun",
  isBondingCurveAddress(address: string): boolean {
    return BONDING_CURVE_ADDRESSES.has(address.toLowerCase());
  },
};
