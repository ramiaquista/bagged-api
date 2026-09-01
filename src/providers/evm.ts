import type { Chain } from "../schemas/chain.js";
import type { WalletPnl } from "../schemas/pnl.js";
import type { Position } from "../schemas/position.js";
import { mockPnlFor, mockPositionsFor } from "./mockData.js";
import type { ChainProvider } from "./types.js";

/**
 * Shared adapter for every EVM chain Bagged covers: BNB Chain, Robinhood
 * Chain, and Ethereum. One integration effort, parameterized by chain —
 * see the product spec's "useful shortcut" note. Only the bonding-curve /
 * launchpad reconciliation (four.meme on BNB, whatever ships on Robinhood
 * Chain) actually differs per chain once this is real.
 *
 * STATUS: stub, returns mock data. Real implementation: Alchemy or Moralis
 * for indexing + fills, chain-specific launchpad-contract reads for
 * pre-graduation pricing, then through src/pnl-engine.
 */
export class EvmProvider implements ChainProvider {
  constructor(readonly chain: Exclude<Chain, "solana">) {}

  async getWalletPnl(address: string): Promise<WalletPnl> {
    return mockPnlFor(this.chain, address);
  }

  async getWalletPositions(_address: string): Promise<Position[]> {
    return mockPositionsFor(this.chain);
  }
}
