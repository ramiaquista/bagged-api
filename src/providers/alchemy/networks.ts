import type { Chain } from "../../schemas/chain.js";

/**
 * Alchemy network slug per EVM chain Bagged covers, used as the
 * `{network}.g.alchemy.com` subdomain.
 *
 * Robinhood Chain confirmed live on Alchemy as `robinhood-mainnet`
 * (chain ID 4663, an Arbitrum-Orbit L2 that settles to Ethereum) as of
 * 2026-07-01 -- see
 * https://www.alchemy.com/blog/robinhood-chain-mainnet-is-live-on-alchemy
 * and https://www.alchemy.com/overviews/launch-a-memecoin-on-robinhood-chain.
 * Hand-verified during this implementation: `eth-mainnet` and
 * `robinhood-mainnet` both answered real JSON-RPC calls with the provisioned
 * key; `bnb-mainnet` returned "BNB_MAINNET is not enabled for this app" --
 * a per-app dashboard toggle (https://dashboard.alchemy.com), not a code
 * issue. See README for the full note.
 */
export const ALCHEMY_NETWORK: Record<Exclude<Chain, "solana">, string> = {
  bnb: "bnb-mainnet",
  robinhood: "robinhood-mainnet",
  ethereum: "eth-mainnet",
};

/** Native gas token per chain, used to price native-currency trade legs via Alchemy's Prices API. */
export const NATIVE_SYMBOL: Record<Exclude<Chain, "solana">, string> = {
  bnb: "BNB",
  robinhood: "ETH", // Robinhood Chain uses ETH for gas (settles to Ethereum).
  ethereum: "ETH",
};
