import type { Chain } from "../../schemas/chain.js";
import { ethereumResolver } from "./ethereum.js";
import { fourMemeResolver } from "./fourMeme.js";
import { hoodFunResolver } from "./hoodFun.js";
import type { LaunchpadResolver } from "./types.js";

const resolvers: Record<Exclude<Chain, "solana">, LaunchpadResolver> = {
  bnb: fourMemeResolver,
  robinhood: hoodFunResolver,
  ethereum: ethereumResolver,
};

export function getLaunchpadResolver(chain: Exclude<Chain, "solana">): LaunchpadResolver {
  return resolvers[chain];
}
