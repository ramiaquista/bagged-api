import type { Chain } from "../schemas/chain.js";
import type { WalletPnl } from "../schemas/pnl.js";
import type { Position } from "../schemas/position.js";

/** One day's real, closed-trade-derived realized PnL for a wallet. See DailyRealizedPnlProvider below. */
export interface DailyRealizedPnl {
  /** UTC calendar day, "YYYY-MM-DD". */
  day: string;
  realizedPnlUsd: number;
  tradeCount: number;
}

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

/**
 * Optional second capability: real day-by-day REALIZED PnL, derived from
 * actual trade history rather than a single point-in-time snapshot -- the
 * source for `/app`'s monthly PnL calendar (src/worker/dailyPnlWorker.ts,
 * src/routes/user.ts).
 *
 * Deliberately NOT folded into `ChainProvider` itself: `SolanaProvider`
 * (src/providers/solana.ts) implements it on top of the same Helius-backed
 * pipeline `getWalletPnl` already uses, but `EvmProvider`
 * (src/providers/evm.ts) is still mock-data-only (see src/pnl-engine/
 * index.ts's module comment) and has no real trade history to bucket by
 * day -- it doesn't implement this. Callers (the daily-PnL worker) check
 * for the method's presence and skip chains that don't have it, the same
 * "graceful, not fatal" shape as the rest of this codebase's provider
 * fallbacks.
 */
export interface DailyRealizedPnlProvider {
  getWalletDailyRealizedPnl(address: string): Promise<DailyRealizedPnl[]>;
}

/** True when a provider also implements the optional daily-realized-PnL capability. */
export function supportsDailyRealizedPnl(
  provider: ChainProvider,
): provider is ChainProvider & DailyRealizedPnlProvider {
  return typeof (provider as Partial<DailyRealizedPnlProvider>).getWalletDailyRealizedPnl === "function";
}
