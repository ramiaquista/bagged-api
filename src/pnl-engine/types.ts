import type { Chain } from "../schemas/chain.js";

/** A single on-chain fill, as it would come off an indexer (Helius, Alchemy, ...). */
export interface Trade {
  txSignature: string;
  chain: Chain;
  wallet: string;
  tokenMintOrAddress: string;
  /**
   * "transfer_out" is a token leaving the wallet with no resolvable market
   * proceeds -- a plain wallet-to-wallet transfer, or an on-chain sell we
   * genuinely couldn't price. It removes the quantity (and its
   * proportional cost basis) from tracked holdings like a sell would, but
   * recognizes no gain or loss: we don't know what happened to the tokens
   * on the other end, so booking a "loss" would be a fabrication. Without
   * this, tokens that leave via transfer stay phantom-"held" forever
   * (quantityHeld never decrements) while their buy-side cost silently
   * drags down realizedPnlUsd anywhere it's computed as proceeds-minus-
   * total-bought instead of from this engine's own running total.
   */
  side: "buy" | "sell" | "transfer_out";
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
