/**
 * Chain-specific bonding-curve / launchpad reconciliation. Each EVM chain
 * Bagged covers has its own pre-graduation pricing venue (four.meme on BNB,
 * a hood.fun-style curve on Robinhood Chain); Ethereum currently has no
 * single dominant equivalent (see ethereum.ts). A resolver's only job is to
 * say "this transfer touched a bonding-curve contract" so trade-building
 * (see ../evmTradeBuilder.ts) can set `Trade.preGraduation`, which is what
 * src/pnl-engine/costBasis.ts's (still-stubbed) bonding-curve-aware cost
 * basis math keys off of.
 */
export interface LaunchpadResolver {
  /** Human-readable name, for logging/debugging only. */
  readonly name: string;
  /** True if `address` is a known bonding-curve / launchpad contract for this chain. */
  isBondingCurveAddress(address: string): boolean;
}
