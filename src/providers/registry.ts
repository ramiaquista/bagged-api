import type { Chain } from "../schemas/chain.js";
import { EvmProvider } from "./evm.js";
import { SolanaProvider } from "./solana.js";
import type { ChainProvider } from "./types.js";

const providers: Record<Chain, ChainProvider> = {
  solana: new SolanaProvider(),
  bnb: new EvmProvider("bnb"),
  robinhood: new EvmProvider("robinhood"),
  ethereum: new EvmProvider("ethereum"),
};

export function getProvider(chain: Chain): ChainProvider {
  return providers[chain];
}
