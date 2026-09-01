import type { LaunchpadResolver } from "./types.js";

/**
 * Ethereum mainnet has no single dominant pump.fun/four.meme-style bonding
 * curve launchpad as of this implementation (2026-09) -- mainnet gas costs
 * (commonly $10-50/swap) push memecoin bonding-curve activity onto L2s and
 * other chains (Base, BNB Chain, Robinhood Chain) rather than Ethereum
 * mainnet itself; candidates researched (Clanker, Zora) either target
 * other chains or aren't bonding-curve/sniping-shaped the way pump.fun and
 * four.meme are. See https://coinbureau.com/analysis/best-memecoin-launchpads
 * for the landscape survey used here.
 *
 * Every fill Bagged sees on Ethereum is therefore treated as a normal
 * (already-AMM-priced) trade -- there is no bonding-curve/graduation
 * boundary to reconcile on this chain, unlike BNB (four.meme) or Robinhood
 * Chain (hood.fun). Revisit if a dominant ETH-mainnet launchpad emerges;
 * this is a deliberate research conclusion, not an unimplemented stub.
 */
export const ethereumResolver: LaunchpadResolver = {
  name: "none (no dominant Ethereum mainnet bonding-curve launchpad as of 2026-09)",
  isBondingCurveAddress(): boolean {
    return false;
  },
};
