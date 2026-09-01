import type { LaunchpadResolver } from "./types.js";

/**
 * four.meme (BNB Chain) bonding-curve reconciliation.
 *
 * four.meme's TokenManager2 proxy is the contract every pre-graduation
 * buy/sell routes through -- a wallet transfer that touches this address as
 * its counterparty is a bonding-curve fill, not a PancakeSwap (AMM) fill.
 * Once a token graduates, trading moves to a PancakeSwap pool and stops
 * touching this address.
 *
 * Source: TokenManager2 proxy address, cross-referenced across public
 * four.meme indexing docs (Bitquery's four.meme API reference --
 * https://docs.bitquery.io/docs/blockchain/BSC/four-meme-api/) as of
 * 2026-09: 0x5c952063c7fc8610FFDB798152D69F0B9550762b. Re-verify on-chain
 * (BscScan "Contract" tab -- confirm it's still the live proxy) before
 * leaning on this for production cost-basis math; launchpad proxies do get
 * upgraded/rotated over time.
 */
const FOUR_MEME_TOKEN_MANAGER_PROXY = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";

export const fourMemeResolver: LaunchpadResolver = {
  name: "four.meme",
  isBondingCurveAddress(address: string): boolean {
    return address.toLowerCase() === FOUR_MEME_TOKEN_MANAGER_PROXY;
  },
};
