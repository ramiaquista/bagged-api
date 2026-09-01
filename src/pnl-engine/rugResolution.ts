import type { RugResolutionResult, Trade } from "./types.js";

/**
 * Resolves positions in tokens that have gone to zero (rugged / honeypot /
 * liquidity pulled) to a clean realized loss instead of leaving them
 * "unpriced" forever.
 *
 * STATUS: stub. Real implementation needs a liquidity/quote-availability
 * check per token (e.g. "no route on Jupiter for N days" or "LP burned")
 * before force-resolving a position.
 */
export function resolveRugs(trades: Trade[]): RugResolutionResult {
  void trades;
  return { resolvedCount: 0, realizedLossUsd: 0 };
}
