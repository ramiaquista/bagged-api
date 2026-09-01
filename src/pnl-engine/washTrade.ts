import type { Trade, WashTradeFilterResult } from "./types.js";

/**
 * Detects and excludes wash trades / sandwich-bot self-trades so they don't
 * inflate realized PnL or volume figures.
 *
 * STATUS: stub. Real implementation should look for round-trip fills from
 * the same wallet (or a wallet cluster) within a short block window, and
 * flag statistically improbable back-to-back buy/sell pairs.
 */
export function filterWashTrades(trades: Trade[]): WashTradeFilterResult {
  return { cleanTrades: trades, excludedCount: 0 };
}
