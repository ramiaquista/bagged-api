import { config } from "../config.js";
import { computeCostBasis, filterWashTrades, resolveRugs } from "../pnl-engine/index.js";
import type { Trade } from "../pnl-engine/types.js";
import type { Chain } from "../schemas/chain.js";
import type { WalletPnl } from "../schemas/pnl.js";
import type { Position } from "../schemas/position.js";
import { fetchAssetMetadata, fetchRecentSwaps } from "./solana/heliusClient.js";
import { fetchUsdPrices } from "./solana/jupiterClient.js";
import { mapHeliusSwapsToTrades, WSOL_MINT } from "./solana/mapTrades.js";
import type { ChainProvider } from "./types.js";

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
export class SolanaProvider implements ChainProvider {
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
      return { perToken: null, washExcluded: 0 };
    }

    let swaps;
    try {
      swaps = await fetchRecentSwaps(address, config.HELIUS_API_KEY);
    } catch {
      return { perToken: null, washExcluded: 0 };
    }

    if (swaps.length === 0) {
      return { perToken: new Map(), washExcluded: 0 };
    }

    const solPrices = await fetchUsdPrices([WSOL_MINT], config.JUPITER_API_BASE_URL);
    const solUsdPrice = solPrices.get(WSOL_MINT) ?? 0;

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
