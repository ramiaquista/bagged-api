import type { Chain } from "../schemas/chain.js";
import type { WalletPnl } from "../schemas/pnl.js";
import type { Position } from "../schemas/position.js";

/**
 * What every chain adapter has to answer. Real implementations sit behind
 * this interface so routes never know or care whether a chain is indexed
 * via Helius, Alchemy, or anything else — see providers/registry.ts.
 */
export interface ChainProvider {
  readonly chain: Chain;
  getWalletPnl(address: string): Promise<WalletPnl>;
  getWalletPositions(address: string): Promise<Position[]>;
}
