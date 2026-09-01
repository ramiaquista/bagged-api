import type { Chain } from "../schemas/chain.js";

/** A single on-chain fill, as it would come off an indexer (Helius, Alchemy, ...). */
export interface Trade {
  txSignature: string;
  chain: Chain;
  wallet: string;
  tokenMintOrAddress: string;
  side: "buy" | "sell";
  quantity: number;
  priceUsd: number;
  timestamp: string; // ISO 8601
  /**
   * True while the token is still trading on a bonding curve (pump.fun,
   * four.meme) rather than a graduated AMM pool. Cost-basis math has to
   * treat pre/post-graduation fills differently — see costBasis.ts.
   */
  preGraduation?: boolean;
}

export interface CostBasisResult {
  quantityHeld: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
}

export interface WashTradeFilterResult {
  cleanTrades: Trade[];
  excludedCount: number;
}

export interface RugResolutionResult {
  /** Trades force-resolved to a realized loss because liquidity vanished. */
  resolvedCount: number;
  realizedLossUsd: number;
}
