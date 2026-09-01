import type { Trade, WashTradeFilterResult } from "./types.js";

/**
 * A buy immediately followed by a sell (or vice versa) of a near-identical
 * quantity, in the same token, within this window, is treated as a wash
 * trade / sandwich-bot round-trip rather than a genuine directional bet.
 * Solana slots are ~400ms; this is a generous margin for clock skew between
 * an indexer's reported timestamps and any block-time rounding.
 */
const WASH_WINDOW_MS = 3_000;

/** How close two quantities have to be (as a fraction of the larger) to count as the "same" round-trip size. */
const QUANTITY_TOLERANCE = 0.01;

/**
 * Detects and excludes wash trades / sandwich-bot self-trades so they don't
 * inflate realized PnL or volume figures.
 *
 * Heuristic: group by token, sort chronologically, and flag adjacent
 * opposite-side trades (buy-then-sell or sell-then-buy) whose quantities
 * match within tolerance and whose timestamps are within the wash window.
 * Both legs of a flagged pair are excluded -- a real round-trip wash trade
 * nets to ~0 quantity and, ignoring fees/slippage, ~0 PnL, so dropping both
 * legs rather than just one avoids leaving a phantom single-sided fill in
 * the clean set.
 *
 * This is a real heuristic, not a certainty: a legitimate trader flipping a
 * position twice in three seconds looks identical on-chain to a wash trade.
 * It trades a small false-positive rate (rare) against the much larger
 * false-negative rate of doing nothing (bots inflating apparent volume/PnL
 * are common on pump.fun-style bonding curves).
 */
export function filterWashTrades(trades: Trade[]): WashTradeFilterResult {
  const byToken = new Map<string, Trade[]>();
  for (const trade of trades) {
    const list = byToken.get(trade.tokenMintOrAddress);
    if (list) {
      list.push(trade);
    } else {
      byToken.set(trade.tokenMintOrAddress, [trade]);
    }
  }

  const excluded = new Set<Trade>();

  for (const list of byToken.values()) {
    const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];
      if (!current || !next) continue;
      if (excluded.has(current) || excluded.has(next)) continue;
      if (current.side === next.side) continue;

      const dtMs = Math.abs(
        new Date(next.timestamp).getTime() - new Date(current.timestamp).getTime(),
      );
      if (!Number.isFinite(dtMs) || dtMs > WASH_WINDOW_MS) continue;

      const largerQty = Math.max(current.quantity, next.quantity, 1e-9);
      const qtyDiffRatio = Math.abs(current.quantity - next.quantity) / largerQty;
      if (qtyDiffRatio > QUANTITY_TOLERANCE) continue;

      excluded.add(current);
      excluded.add(next);
    }
  }

  const cleanTrades = trades.filter((trade) => !excluded.has(trade));
  return { cleanTrades, excludedCount: excluded.size };
}
