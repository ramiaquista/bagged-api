import { config } from "../config.js";
import { computeCostBasis, filterWashTrades, resolveRugs } from "../pnl-engine/index.js";
import type { Trade } from "../pnl-engine/types.js";
import type { Chain } from "../schemas/chain.js";
import type { WalletPnl } from "../schemas/pnl.js";
import type { Position } from "../schemas/position.js";
import { fetchAssetMetadata, fetchRecentSwaps } from "./solana/heliusClient.js";
import { fetchUsdPrices } from "./solana/jupiterClient.js";
import { mapHeliusSwapsToTrades, WSOL_MINT } from "./solana/mapTrades.js";
import type { ChainProvider, DailyRealizedPnl, DailyRealizedPnlProvider, TokenTradeHistory, TradesProvider } from "./types.js";

const DUST_QTY = 1e-9;

interface TokenAccumulator {
  mint: string;
  /** Wash-trade-filtered fills for this mint, kept around for resolveRugs. */
  trades: Trade[];
  quantityHeld: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Solana adapter — the one chain that isn't EVM, so it gets its own
 * implementation (see providers/evm.ts for the shared BNB/Robinhood/Ethereum
 * one).
 *
 * REAL IMPLEMENTATION (Item 2, NEXT_STEPS.md):
 *   - Helius Enhanced Transaction History for a wallet's recent SWAP fills
 *     (providers/solana/heliusClient.ts)
 *   - providers/solana/mapTrades.ts turns those into pnl-engine `Trade[]`,
 *     pricing both pre-graduation (pump.fun bonding-curve) and
 *     post-graduation (AMM pool) fills uniformly in USD
 *   - src/pnl-engine: filterWashTrades -> computeCostBasis -> resolveRugs,
 *     run per token
 *   - Jupiter Price API (providers/solana/jupiterClient.ts) for current
 *     SOL/USD (to price SOL-denominated fills) and for current token prices
 *     (unrealized PnL / position value, and as a liquidity/rug signal when
 *     a mint has no live price at all)
 *
 * GRACEFUL DEGRADATION: if `HELIUS_API_KEY` isn't configured, or the Helius
 * call fails outright (bad address, rate limit, network error), this
 * returns a well-formed zeroed-out `WalletPnl` / empty positions list
 * rather than throwing — a wallet with literally no indexed swap history
 * looks the same as a misconfigured environment, by design, so every route
 * stays a 200 with a valid response shape either way.
 *
 * See the Item 2 hand-off report for validated wallets and known
 * approximations (documented in detail in mapTrades.ts and resolveRugs's
 * doc comment).
 */
export class SolanaProvider implements ChainProvider, DailyRealizedPnlProvider, TradesProvider {
  readonly chain: Chain = "solana";

  async getWalletPnl(address: string): Promise<WalletPnl> {
    const { perToken, washExcluded } = await this.loadTokenPositions(address);

    if (perToken === null) {
      return this.zeroPnl(address);
    }

    const heldMints = [...perToken.values()]
      .filter((t) => t.quantityHeld > DUST_QTY)
      .map((t) => t.mint);
    const currentPrices = await fetchUsdPrices(heldMints, config.JUPITER_API_BASE_URL);

    let realizedPnlUsd = 0;
    let unrealizedPnlUsd = 0;
    let positionsOpen = 0;
    let rugsResolved = 0;

    for (const acc of perToken.values()) {
      realizedPnlUsd += acc.realizedPnlUsd;
      if (acc.quantityHeld <= DUST_QTY) continue;

      const livePrice = currentPrices.get(acc.mint);
      const rugSignal = resolveRugs(acc.trades);
      const isRugged = rugSignal.resolvedCount > 0 || livePrice === undefined;

      if (isRugged) {
        // No live route/price at all, or the trade-history heuristic
        // already flagged a price collapse -- force-resolve the residual
        // holding to a realized loss instead of leaving it "open" with an
        // unknowable value. See rugResolution.ts's doc comment.
        realizedPnlUsd -= acc.costBasisUsd;
        rugsResolved += 1;
        continue;
      }

      const valueUsd = acc.quantityHeld * livePrice;
      unrealizedPnlUsd += valueUsd - acc.costBasisUsd;
      positionsOpen += 1;
    }

    return {
      wallet: address,
      chain: this.chain,
      as_of: new Date().toISOString(),
      realized_pnl_usd: round(realizedPnlUsd, 2),
      unrealized_pnl_usd: round(unrealizedPnlUsd, 2),
      total_pnl_usd: round(realizedPnlUsd + unrealizedPnlUsd, 2),
      positions_open: positionsOpen,
      wash_trades_excluded: washExcluded,
      rugs_resolved: rugsResolved,
    };
  }

  async getWalletPositions(address: string): Promise<Position[]> {
    const { perToken } = await this.loadTokenPositions(address);
    if (perToken === null) return [];

    const held = [...perToken.values()].filter((t) => t.quantityHeld > DUST_QTY);
    if (held.length === 0) return [];

    const mints = held.map((t) => t.mint);
    const [currentPrices, metadata] = await Promise.all([
      fetchUsdPrices(mints, config.JUPITER_API_BASE_URL),
      fetchAssetMetadata(mints, config.HELIUS_API_KEY ?? ""),
    ]);

    const positions: Position[] = [];

    for (const acc of held) {
      const livePrice = currentPrices.get(acc.mint);
      const rugSignal = resolveRugs(acc.trades);
      // Mirrors getWalletPnl's rug treatment: a rugged/unpriceable holding
      // isn't an "open position" in the API's terms.
      if (livePrice === undefined || rugSignal.resolvedCount > 0) continue;

      const valueUsd = acc.quantityHeld * livePrice;
      const unrealizedPnlUsd = valueUsd - acc.costBasisUsd;
      const unrealizedPnlPct =
        acc.costBasisUsd > 0 ? (unrealizedPnlUsd / acc.costBasisUsd) * 100 : 0;
      const symbol = metadata.get(acc.mint)?.content?.metadata?.symbol || acc.mint.slice(0, 6);

      positions.push({
        token: symbol,
        mint_or_address: acc.mint,
        quantity: round(acc.quantityHeld, 6),
        value_usd: round(valueUsd, 2),
        cost_basis_usd: round(acc.costBasisUsd, 2),
        unrealized_pnl_usd: round(unrealizedPnlUsd, 2),
        unrealized_pnl_pct: round(unrealizedPnlPct, 2),
      });
    }

    return positions.sort((a, b) => b.value_usd - a.value_usd);
  }

  // TradesProvider implementation
  async getWalletTrades(address: string): Promise<TokenTradeHistory[]> {
    const { perToken } = await this.loadTokenPositions(address);
    if (perToken === null) return [];

    // Fetch metadata to get symbols
    const mints = Array.from(perToken.keys());
    const metadata = await fetchAssetMetadata(mints, config.HELIUS_API_KEY ?? "");

    return Array.from(perToken.entries()).map(([mint, acc]) => {
      const buyTrades = acc.trades.filter((t) => t.side === "buy");
      const sellTrades = acc.trades.filter((t) => t.side === "sell");

      const quantityBought = buyTrades.reduce((sum, t) => sum + t.quantity, 0);
      const quantitySold = sellTrades.reduce((sum, t) => sum + t.quantity, 0);

      // Calculate cost basis directly from buy trades
      const costBasisUsd = buyTrades.reduce((sum, t) => sum + (t.quantity * t.priceUsd), 0);
      const proceedsUsd = sellTrades.reduce((sum, t) => sum + (t.quantity * t.priceUsd), 0);

      const lastTradeTimestamp = acc.trades.length > 0
        ? acc.trades[acc.trades.length - 1]?.timestamp
        : undefined;
      const holdingDurationMs = lastTradeTimestamp
        ? new Date().getTime() - new Date(lastTradeTimestamp).getTime()
        : undefined;

      const symbol = metadata.get(mint)?.content?.metadata?.symbol || mint.slice(0, 6);

      return {
        symbol,
        tokenAddress: mint,
        quantityBought: round(quantityBought, 6),
        costBasisUsd: round(costBasisUsd, 2),
        quantitySold: round(quantitySold, 6),
        proceedsUsd: round(proceedsUsd, 2),
        realizedPnlUsd: round(proceedsUsd - costBasisUsd, 2),
        quantityHeld: round(acc.quantityHeld, 6),
        holdingDurationMs,
      };
    });
  }

  /**
   * Real per-day REALIZED PnL (see providers/types.ts's DailyRealizedPnlProvider
   * doc comment for why this is realized-only). Reuses loadTokenPositions's
   * already-fetched, already-wash-filtered trades -- no extra network
   * calls -- and re-walks each mint's clean trades through
   * computeCostBasis a second time purely for its per-sell-event callback;
   * that walk is pure/cheap (no I/O), and keeping it separate from the
   * aggregate call in getWalletPnl/getWalletPositions avoids threading an
   * optional callback through every other call site for a capability only
   * this one needs.
   *
   * Bucketed by the UTC calendar day of each trade's own timestamp (already
   * ISO 8601 -- see pnl-engine/types.ts's Trade.timestamp), so a day's
   * figure only ever reflects trades whose fills actually happened that
   * day. Empty array (not zeros) when there's no configured Helius key or
   * the wallet has no indexed history -- same "well-formed but empty"
   * degradation as loadTokenPositions's null-perToken case elsewhere in
   * this file.
   */
  async getWalletDailyRealizedPnl(address: string): Promise<DailyRealizedPnl[]> {
    const { perToken } = await this.loadTokenPositions(address);
    if (perToken === null) return [];

    const byDay = new Map<string, { realizedPnlUsd: number; tradeCount: number }>();
    const onRealize = (timestamp: string, deltaUsd: number): void => {
      const day = timestamp.slice(0, 10);
      const existing = byDay.get(day);
      if (existing) {
        existing.realizedPnlUsd += deltaUsd;
        existing.tradeCount += 1;
      } else {
        byDay.set(day, { realizedPnlUsd: deltaUsd, tradeCount: 1 });
      }
    };

    for (const acc of perToken.values()) {
      computeCostBasis(acc.trades, onRealize);
    }

    const result = [...byDay.entries()]
      .map(([day, v]) => ({ day, realizedPnlUsd: round(v.realizedPnlUsd, 2), tradeCount: v.tradeCount }))
      .sort((a, b) => a.day.localeCompare(b.day));

    console.error(`[Solana] Daily PnL for ${address}: ${result.length} days calculated from ${perToken.size} tokens`);
    if (result.length === 0 && perToken.size > 0) {
      console.error(`[Solana] WARNING: ${perToken.size} tokens but 0 days with realized PnL`);
      for (const [mint, acc] of perToken.entries()) {
        console.error(`[Solana]   ${mint}: ${acc.trades.length} trades, realized=${acc.realizedPnlUsd}, cost=${acc.costBasisUsd}`);
      }
    }

    return result;
  }

  private zeroPnl(address: string): WalletPnl {
    return {
      wallet: address,
      chain: this.chain,
      as_of: new Date().toISOString(),
      realized_pnl_usd: 0,
      unrealized_pnl_usd: 0,
      total_pnl_usd: 0,
      positions_open: 0,
      wash_trades_excluded: 0,
      rugs_resolved: 0,
    };
  }

  /**
   * Shared pipeline for both routes: fetch swaps -> map to Trade[] -> group
   * by mint -> filterWashTrades -> computeCostBasis, per mint.
   *
   * Returns `perToken: null` to signal "couldn't load real data" (no API
   * key configured, or the Helius call failed) so callers can fall back to
   * a zeroed/empty response instead of throwing.
   */
  private async loadTokenPositions(
    address: string,
  ): Promise<{ perToken: Map<string, TokenAccumulator> | null; washExcluded: number }> {
    if (!config.HELIUS_API_KEY) {
      console.warn(`[Solana] No HELIUS_API_KEY configured for address ${address}`);
      return { perToken: null, washExcluded: 0 };
    }

    let swaps;
    try {
      swaps = await fetchRecentSwaps(address, config.HELIUS_API_KEY);
      console.error(`[Solana] Helius returned ${swaps.length} swaps for ${address}`);
    } catch (err) {
      console.error(`[Solana] Helius fetch failed for ${address}:`, err);
      return { perToken: null, washExcluded: 0 };
    }

    if (swaps.length === 0) {
      console.error(`[Solana] No swaps found for ${address}`);
      return { perToken: new Map(), washExcluded: 0 };
    }

    const solPrices = await fetchUsdPrices([WSOL_MINT], config.JUPITER_API_BASE_URL);
    let solUsdPrice = solPrices.get(WSOL_MINT);
    console.error(`[Solana] SOL price: $${solUsdPrice ?? "unknown"} (JUPITER_API_BASE_URL=${config.JUPITER_API_BASE_URL})`);

    if (!solUsdPrice) {
      // Fallback: Jupiter API failed. Use a conservative placeholder price.
      // This prevents trades from being priced at $0, which would filter them all out.
      // Note: these prices will be inaccurate, but at least trades will be visible for debugging.
      console.error(`[Solana] WARNING: Failed to fetch SOL price from Jupiter API. Using fallback price of $1 USD/SOL.`);
      solUsdPrice = 1; // Very low fallback to make inaccuracy obvious
    }

    const rawTrades = mapHeliusSwapsToTrades(address, swaps, solUsdPrice);

    const byMint = new Map<string, Trade[]>();
    for (const trade of rawTrades) {
      const list = byMint.get(trade.tokenMintOrAddress);
      if (list) {
        list.push(trade);
      } else {
        byMint.set(trade.tokenMintOrAddress, [trade]);
      }
    }

    const perToken = new Map<string, TokenAccumulator>();
    let washExcluded = 0;

    for (const [mint, trades] of byMint) {
      const { cleanTrades, excludedCount } = filterWashTrades(trades);
      washExcluded += excludedCount;
      const { quantityHeld, costBasisUsd, realizedPnlUsd } = computeCostBasis(cleanTrades);
      perToken.set(mint, { mint, trades: cleanTrades, quantityHeld, costBasisUsd, realizedPnlUsd });
    }

    return { perToken, washExcluded };
  }
}
