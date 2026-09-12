import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { computeCostBasis, filterWashTrades, resolveRugs, type CostBasisResult, type Trade } from "../pnl-engine/index.js";
import type { Chain } from "../schemas/chain.js";
import type { WalletPnl } from "../schemas/pnl.js";
import type { Position } from "../schemas/position.js";
import { AlchemyHttpClient, type AlchemyClient } from "./alchemy/client.js";
import { isEvmAddress } from "./evmAddress.js";
import { buildTradesFromTransfers } from "./evmTradeBuilder.js";
import { getLaunchpadResolver } from "./launchpads/registry.js";
import type { LaunchpadResolver } from "./launchpads/types.js";
import { mockPnlFor, mockPositionsFor } from "./mockData.js";
import type { ChainProvider, DailyRealizedPnl, DailyRealizedPnlProvider, TradesProvider, TokenTradeHistory } from "./types.js";

export interface EvmProviderDeps {
  /** Injectable for tests; defaults to a real AlchemyHttpClient built from config.ALCHEMY_API_KEY. */
  alchemy?: AlchemyClient;
  /** Injectable for tests; defaults to the chain's registered LaunchpadResolver. */
  launchpad?: LaunchpadResolver;
}

interface TokenPosition {
  tokenAddress: string;
  symbol: string;
  costBasis: CostBasisResult;
  priceUsd: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Shared adapter for every EVM chain Bagged covers: BNB Chain, Robinhood
 * Chain, and Ethereum. One integration effort, parameterized by chain --
 * see the product spec's "useful shortcut" note. Only the bonding-curve /
 * launchpad reconciliation (four.meme on BNB, hood.fun on Robinhood Chain,
 * no equivalent on Ethereum -- see src/providers/launchpads/) actually
 * differs per chain.
 *
 * Provider choice: Alchemy, not Moralis. The spec left this undecided;
 * Alchemy is what's actually provisioned (ALCHEMY_API_KEY in .env) and it
 * covers all three EVM chains here out of the box -- including Robinhood
 * Chain, which went live on Alchemy the same week the chain itself did
 * (2026-07-01, see src/providers/alchemy/networks.ts). Revisit only if
 * Alchemy's coverage, pricing, or rate limits stop working for this use
 * case -- nothing here is Alchemy-API-shaped beyond the AlchemyClient
 * interface, so swapping to Moralis later is a contained change.
 *
 * Real-data pipeline: Alchemy `alchemy_getAssetTransfers` (native + ERC-20
 * fills) -> buildTradesFromTransfers (pairs native/token legs into priced
 * Trade[], tags four.meme/hood.fun bonding-curve fills) -> src/pnl-engine
 * (filterWashTrades -> computeCostBasis -> resolveRugs, real as of the
 * item-2-solana-provider merge) -> WalletPnl / Position[].
 *
 * Graceful-degradation policy:
 *   - Address isn't a well-formed 0x address, or ALCHEMY_API_KEY isn't
 *     configured: fall back to the existing mock data. This preserves the
 *     pre-existing stub behavior (and the existing test suite, which calls
 *     routes with placeholder addresses like "some-address").
 *   - Address is well-formed and Alchemy IS configured, but the upstream
 *     call itself fails (network error, rate limit, or a chain not enabled
 *     for this Alchemy app -- BNB Chain hit this during hand validation,
 *     see README): throw a 502 ApiError instead of silently returning mock
 *     numbers. Silently substituting fake-but-plausible PnL for a real
 *     wallet is worse than a visible error for a financial product.
 */
export class EvmProvider implements ChainProvider, TradesProvider, DailyRealizedPnlProvider {
  private readonly alchemy?: AlchemyClient;
  private readonly launchpad: LaunchpadResolver;

  constructor(
    readonly chain: Exclude<Chain, "solana">,
    deps: EvmProviderDeps = {},
  ) {
    this.alchemy =
      deps.alchemy ?? (config.ALCHEMY_API_KEY ? new AlchemyHttpClient(chain, config.ALCHEMY_API_KEY) : undefined);
    this.launchpad = deps.launchpad ?? getLaunchpadResolver(chain);
  }

  async getWalletPnl(address: string): Promise<WalletPnl> {
    if (!isEvmAddress(address) || !this.alchemy) {
      return mockPnlFor(this.chain, address);
    }

    const { positions, washResult, rugResult } = await this.loadPortfolio(address, this.alchemy);

    let realizedPnlUsd = -rugResult.realizedLossUsd;
    let unrealizedPnlUsd = 0;
    let positionsOpen = 0;
    for (const p of positions) {
      realizedPnlUsd += p.costBasis.realizedPnlUsd;
      if (p.costBasis.quantityHeld > 0) {
        positionsOpen += 1;
        unrealizedPnlUsd += p.costBasis.quantityHeld * (p.priceUsd ?? 0) - p.costBasis.costBasisUsd;
      }
    }

    return {
      wallet: address,
      chain: this.chain,
      realized_pnl_usd: round2(realizedPnlUsd),
      unrealized_pnl_usd: round2(unrealizedPnlUsd),
      total_pnl_usd: round2(realizedPnlUsd + unrealizedPnlUsd),
      positions_open: positionsOpen,
      wash_trades_excluded: washResult.excludedCount,
      rugs_resolved: rugResult.resolvedCount,
      as_of: new Date().toISOString(),
    };
  }

  async getWalletPositions(address: string): Promise<Position[]> {
    if (!isEvmAddress(address) || !this.alchemy) {
      return mockPositionsFor(this.chain);
    }

    const { positions } = await this.loadPortfolio(address, this.alchemy);

    return positions
      .filter((p) => p.costBasis.quantityHeld > 0)
      .map((p) => {
        const valueUsd = p.costBasis.quantityHeld * (p.priceUsd ?? 0);
        const unrealizedPnlUsd = valueUsd - p.costBasis.costBasisUsd;
        const unrealizedPnlPct = p.costBasis.costBasisUsd > 0 ? (unrealizedPnlUsd / p.costBasis.costBasisUsd) * 100 : 0;
        return {
          token: p.symbol,
          mint_or_address: p.tokenAddress,
          quantity: p.costBasis.quantityHeld,
          value_usd: round2(valueUsd),
          cost_basis_usd: round2(p.costBasis.costBasisUsd),
          unrealized_pnl_usd: round2(unrealizedPnlUsd),
          unrealized_pnl_pct: round2(unrealizedPnlPct),
        };
      });
  }

  // DailyRealizedPnlProvider implementation
  async getWalletDailyRealizedPnl(address: string): Promise<DailyRealizedPnl[]> {
    if (!isEvmAddress(address) || !this.alchemy) {
      return [];
    }

    const { washResult } = await this.loadPortfolio(address, this.alchemy);

    // Track realized PnL by day using the computeCostBasis callback
    const byDay = new Map<string, { realizedPnlUsd: number; tradeCount: number }>();
    const onRealize = (timestamp: string, deltaUsd: number): void => {
      const day = timestamp.slice(0, 10); // YYYY-MM-DD
      const existing = byDay.get(day);
      if (existing) {
        existing.realizedPnlUsd += deltaUsd;
        existing.tradeCount += 1;
      } else {
        byDay.set(day, { realizedPnlUsd: deltaUsd, tradeCount: 1 });
      }
    };

    // Process each token's trades to compute daily realized PnL
    const byToken = new Map<string, Trade[]>();
    for (const t of washResult.cleanTrades) {
      const arr = byToken.get(t.tokenMintOrAddress);
      if (arr) arr.push(t);
      else byToken.set(t.tokenMintOrAddress, [t]);
    }

    for (const trades of byToken.values()) {
      computeCostBasis(trades, onRealize);
    }

    // Convert to sorted array
    const result: DailyRealizedPnl[] = Array.from(byDay.entries())
      .map(([day, v]) => ({ day, realizedPnlUsd: round2(v.realizedPnlUsd), tradeCount: v.tradeCount }))
      .sort((a, b) => a.day.localeCompare(b.day));

    return result;
  }

  // TradesProvider implementation
  async getWalletTrades(address: string): Promise<TokenTradeHistory[]> {
    if (!isEvmAddress(address) || !this.alchemy) {
      return [];
    }

    const { positions, rawTrades, tradesByToken, symbolByToken, firstTradeTimestamp } = await this.loadPortfolioWithTrades(address, this.alchemy);

    // DEBUG: Log input to computeCostBasis
    for (const [token, trades] of tradesByToken) {
      const buys = trades.filter(t => t.side === "buy");
      const sells = trades.filter(t => t.side === "sell");
      if (buys.length > 0) {
        const buySum = buys.reduce((sum, t) => sum + (t.quantity * t.priceUsd), 0);
        console.log(`[evm.ts] Before costBasis: token=${token.slice(0,6)} buys=${buys.length} (sum cost=${buySum.toFixed(2)}) sells=${sells.length}`);
      }
    }

    return positions.map((p) => {
      const tokenTrades = tradesByToken.get(p.tokenAddress) || [];
      const buyTrades = tokenTrades.filter((t) => t.side === "buy");
      const sellTrades = tokenTrades.filter((t) => t.side === "sell");
      const quantityBought = buyTrades.reduce((sum, t) => sum + t.quantity, 0);
      const quantitySold = sellTrades.reduce((sum, t) => sum + t.quantity, 0);

      // Calculate cost basis directly from buy trades
      // (not from p.costBasis which may be 0 if position is fully liquidated)
      const costBasisUsd = buyTrades.reduce((sum, t) => sum + (t.quantity * t.priceUsd), 0);
      const proceedsUsd = tokenTrades
        .filter((t) => t.side === "sell")
        .reduce((sum, t) => sum + t.quantity * t.priceUsd, 0);

      const lastTradeTimestamp = tokenTrades.length > 0
        ? tokenTrades[tokenTrades.length - 1]?.timestamp
        : firstTradeTimestamp;
      const holdingDurationMs = lastTradeTimestamp
        ? new Date().getTime() - new Date(lastTradeTimestamp).getTime()
        : undefined;

      return {
        symbol: p.symbol,
        tokenAddress: p.tokenAddress,
        quantityBought: round2(quantityBought),
        costBasisUsd: round2(costBasisUsd),  // Calculate from buys, not from p.costBasis (which is 0 for liquidated positions)
        quantitySold: round2(quantitySold),
        proceedsUsd: round2(proceedsUsd),
        realizedPnlUsd: round2(proceedsUsd - costBasisUsd),  // Recalculate PnL: proceeds - cost
        quantityHeld: round2(p.costBasis.quantityHeld),
        holdingDurationMs,
      };
    });
  }

  private async loadPortfolio(address: string, alchemy: AlchemyClient) {
    let transfers;
    let nativePriceUsd;
    try {
      [transfers, nativePriceUsd] = await Promise.all([
        alchemy.getAllTransfers(address),
        alchemy.getNativePriceUsd(),
      ]);
    } catch (err) {
      throw new ApiError(
        502,
        "upstream_provider_error",
        `Failed to fetch ${this.chain} wallet data from Alchemy: ${(err as Error).message}`,
      );
    }

    const rawTrades = await buildTradesFromTransfers(address, this.chain, transfers, nativePriceUsd, this.launchpad, alchemy);

    const washResult = filterWashTrades(rawTrades);
    const rugResult = resolveRugs(washResult.cleanTrades);

    const byToken = new Map<string, Trade[]>();
    for (const t of washResult.cleanTrades) {
      const arr = byToken.get(t.tokenMintOrAddress);
      if (arr) arr.push(t);
      else byToken.set(t.tokenMintOrAddress, [t]);
    }

    const symbolByToken = new Map<string, string>();
    for (const t of transfers) {
      if (t.tokenAddress && t.asset && !symbolByToken.has(t.tokenAddress)) {
        symbolByToken.set(t.tokenAddress, t.asset);
      }
    }

    const positions: TokenPosition[] = [];
    for (const [tokenAddress, tokenTrades] of byToken) {
      const costBasis = computeCostBasis(tokenTrades);
      let priceUsd: number | null = null;
      if (costBasis.quantityHeld > 0) {
        try {
          priceUsd = await alchemy.getTokenPriceUsd(tokenAddress);
        } catch {
          priceUsd = null; // one token's price lookup failing shouldn't fail the whole wallet.
        }
      }
      positions.push({
        tokenAddress,
        symbol: symbolByToken.get(tokenAddress) ?? tokenAddress,
        costBasis,
        priceUsd,
      });
    }

    return { positions, washResult, rugResult };
  }

  private async loadPortfolioWithTrades(address: string, alchemy: AlchemyClient) {
    let transfers;
    let nativePriceUsd;
    try {
      [transfers, nativePriceUsd] = await Promise.all([
        alchemy.getAllTransfers(address),
        alchemy.getNativePriceUsd(),
      ]);
    } catch (err) {
      throw new ApiError(
        502,
        "upstream_provider_error",
        `Failed to fetch ${this.chain} wallet data from Alchemy: ${(err as Error).message}`,
      );
    }

    const rawTrades = await buildTradesFromTransfers(address, this.chain, transfers, nativePriceUsd, this.launchpad, alchemy);

    const washResult = filterWashTrades(rawTrades);
    const rugResult = resolveRugs(washResult.cleanTrades);

    const byToken = new Map<string, Trade[]>();
    for (const t of washResult.cleanTrades) {
      const arr = byToken.get(t.tokenMintOrAddress);
      if (arr) arr.push(t);
      else byToken.set(t.tokenMintOrAddress, [t]);
    }

    const symbolByToken = new Map<string, string>();
    for (const t of transfers) {
      if (t.tokenAddress && t.asset && !symbolByToken.has(t.tokenAddress)) {
        symbolByToken.set(t.tokenAddress, t.asset);
      }
    }

    let firstTradeTimestamp: string | undefined;
    const positions: TokenPosition[] = [];
    for (const [tokenAddress, tokenTrades] of byToken) {
      const costBasis = computeCostBasis(tokenTrades);
      let priceUsd: number | null = null;
      if (costBasis.quantityHeld > 0) {
        try {
          priceUsd = await alchemy.getTokenPriceUsd(tokenAddress);
        } catch {
          priceUsd = null;
        }
      }
      if (tokenTrades.length > 0 && !firstTradeTimestamp) {
        firstTradeTimestamp = tokenTrades[0]?.timestamp ?? undefined;
      }
      positions.push({
        tokenAddress,
        symbol: symbolByToken.get(tokenAddress) ?? tokenAddress,
        costBasis,
        priceUsd,
      });
    }

    return { positions, washResult, rugResult, rawTrades, tradesByToken: byToken, symbolByToken, firstTradeTimestamp };
  }
}
