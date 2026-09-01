import type { Chain } from "../schemas/chain.js";
import type { WalletPnl } from "../schemas/pnl.js";
import type { Position } from "../schemas/position.js";
import { mockPnlFor, mockPositionsFor } from "./mockData.js";
import type { ChainProvider } from "./types.js";

/**
 * Solana adapter — the one chain that isn't EVM, so it gets its own
 * implementation (see providers/evm.ts for the shared BNB/Robinhood/Ethereum
 * one).
 *
 * STATUS: stub, returns mock data. Real implementation:
 *   - Helius (RPC + webhooks + LaserStream) for fills and account state
 *   - Direct pump.fun program reads for pre-graduation bonding-curve pricing
 *   - Jupiter price API for post-graduation / general token pricing
 *   - Feed raw fills through src/pnl-engine before returning a result
 */
export class SolanaProvider implements ChainProvider {
  readonly chain: Chain = "solana";

  async getWalletPnl(address: string): Promise<WalletPnl> {
    return mockPnlFor(this.chain, address);
  }

  async getWalletPositions(_address: string): Promise<Position[]> {
    return mockPositionsFor(this.chain);
  }
}
