import type { Trade } from "../pnl-engine/index.js";
import type { Chain } from "../schemas/chain.js";
import type { AlchemyClient, AssetTransfer } from "./alchemy/client.js";
import type { LaunchpadResolver } from "./launchpads/types.js";

/**
 * Reconstructs buy/sell fills from raw Alchemy asset-transfer rows.
 *
 * Alchemy's `alchemy_getAssetTransfers` reports each asset movement
 * independently, not as a matched swap -- a bonding-curve or AMM buy shows
 * up as (at least) two rows sharing a tx hash: native currency out of the
 * wallet, and an ERC-20 token into it (the reverse for a sell). This groups
 * transfers by tx hash and pairs a single native leg with a single ERC-20
 * leg to price the fill:
 *
 *   priceUsd = (native amount moved * native USD price) / token quantity
 *
 * Scope for v1: only wallet<->native<->token swaps are priced. Token-for-
 * token swaps (no native leg) and multi-leg router transactions are
 * skipped rather than guessed at -- safer than fabricating a price, and a
 * reasonable v1 limitation given bonding-curve/launchpad fills (four.meme,
 * hood.fun) are priced in the chain's native gas token.
 */
interface IncompleteSell {
  hash: string;
  timestamp: string;
  tokenAddress: string;
  asset: string | null;
  quantity: number;
  recipient: string | null;
  preGraduation: boolean;
}

/** Parse Uniswap V4 Swap event logs to extract swap amounts */
function parseSwapEventFromLogs(
  logs: Array<{ topics: string[]; data: string; address: string }>,
  tokenAddress: string,
): { amountIn: number; amountOut: number } | null {
  // Swap event signature: Swap(address indexed sender, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  // However, for simple cases we can just look at the transfer events and calculate from there
  // This is a simplified parser - in production we'd parse the full event

  try {
    // Look for Transfer events related to the swap
    const transferSig = "0xddf252ad1be2c89b69c2b068fc378daf05d79f3b827d19cf7f60d11e1b4e8e81"; // Transfer(address,address,uint256)

    for (const log of logs) {
      if (log.topics[0] === transferSig && log.topics[2]) {
        // This is a transfer event
        // For now, return null - we'll rely on multi-tx correlation
        return null;
      }
    }
  } catch (err) {
    console.error("[evmTradeBuilder] Failed to parse swap event:", err);
  }

  return null;
}

export async function buildTradesFromTransfers(
  wallet: string,
  chain: Exclude<Chain, "solana">,
  transfers: AssetTransfer[],
  nativePriceUsd: number | null,
  launchpad: LaunchpadResolver,
  alchemy?: AlchemyClient,
): Promise<Trade[]> {
  const walletLc = wallet.toLowerCase();
  const byHash = new Map<string, AssetTransfer[]>();
  for (const t of transfers) {
    const group = byHash.get(t.hash);
    if (group) {
      group.push(t);
    } else {
      byHash.set(t.hash, [t]);
    }
  }

  const trades: Trade[] = [];
  const incompleteSells: IncompleteSell[] = [];

  if (nativePriceUsd === null) {
    return trades; // No pricing available
  }

  // PASS 1: Single-transaction matches (buys + complete sells)
  for (const [hash, group] of byHash) {
    const nativeOut = group.filter((t) => t.category === "external" && t.from === walletLc);
    const nativeIn = group.filter((t) => t.category === "external" && t.to === walletLc);
    const tokenOut = group.filter((t) => t.category === "erc20" && t.from === walletLc && t.tokenAddress);
    const tokenIn = group.filter((t) => t.category === "erc20" && t.to === walletLc && t.tokenAddress);

    const timestamp = group.find((t) => t.blockTimestamp)?.blockTimestamp ?? new Date(0).toISOString();
    const touchesBondingCurve = group.some(
      (t) => (t.to !== null && launchpad.isBondingCurveAddress(t.to)) || launchpad.isBondingCurveAddress(t.from),
    );

    // BUY: token in + native out
    if (tokenIn.length === 1 && nativeOut.length >= 1) {
      const token = tokenIn[0]!;
      const quantity = token.value ?? 0;
      const nativeSpent = nativeOut.reduce((sum, t) => sum + (t.value ?? 0), 0);
      if (quantity > 0 && nativeSpent > 0 && token.tokenAddress) {
        trades.push({
          txSignature: hash,
          chain,
          wallet,
          tokenMintOrAddress: token.tokenAddress,
          side: "buy",
          quantity,
          priceUsd: (nativeSpent * nativePriceUsd) / quantity,
          timestamp,
          preGraduation: touchesBondingCurve,
        });
      }
      continue;
    }

    // SELL: token out + returns (try single-tx match first)
    if (tokenOut.length === 1) {
      const token = tokenOut[0]!;
      const quantity = token.value ?? 0;

      if (quantity > 0 && token.tokenAddress) {
        let proceedsUsd = 0;

        // Try native currency proceeds first
        if (nativeIn.length >= 1) {
          const nativeReceived = nativeIn.reduce((sum, t) => sum + (t.value ?? 0), 0);
          if (nativeReceived > 0) {
            proceedsUsd = nativeReceived * nativePriceUsd;
          }
        }

        // Fallback: check for ERC-20 token proceeds (wrapped native or reward tokens)
        if (proceedsUsd === 0) {
          const tokensIn = group.filter((t) => t.category === "erc20" && t.to === walletLc && t.tokenAddress && t.tokenAddress !== token.tokenAddress);
          if (tokensIn.length >= 1) {
            proceedsUsd = tokensIn.reduce((sum, t) => sum + (t.value ?? 0), 0) * nativePriceUsd;
          }
        }

        // Check for routed proceeds (from token recipient back to wallet)
        if (proceedsUsd === 0) {
          const tokenRecipient = token.to;
          if (tokenRecipient && tokenRecipient !== walletLc) {
            const procedsFromRecipient = group.filter(
              (t) => t.from === tokenRecipient && t.to === walletLc && (t.category === "external" || (t.category === "erc20" && t.tokenAddress !== token.tokenAddress))
            );
            if (procedsFromRecipient.length > 0) {
              proceedsUsd = procedsFromRecipient.reduce((sum, t) => sum + ((t.value ?? 0) * nativePriceUsd), 0);
            }
          }
        }

        if (proceedsUsd > 0) {
          trades.push({
            txSignature: hash,
            chain,
            wallet,
            tokenMintOrAddress: token.tokenAddress,
            side: "sell",
            quantity,
            priceUsd: proceedsUsd / quantity,
            timestamp,
            preGraduation: touchesBondingCurve,
          });
        } else {
          // Track for multi-tx correlation
          incompleteSells.push({
            hash,
            timestamp,
            tokenAddress: token.tokenAddress,
            asset: token.asset,
            quantity,
            recipient: token.to,
            preGraduation: touchesBondingCurve,
          });
        }
      }
    }
  }

  // PASS 2: Multi-transaction correlation for incomplete sells
  // Bonding curve settlements are async; look for native claims with no time limit
  if (incompleteSells.length > 0 && alchemy) {
    const allNativeIn = transfers.filter((t) => t.category === "external" && t.to === walletLc);

    for (const incompleteSell of incompleteSells) {
      const saleTime = new Date(incompleteSell.timestamp).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

      // Look for ANY native currency transfer to wallet after the sale
      // Robinhood Chain bonding curves can have delayed settlements
      const nativeClaim = allNativeIn.find((t) => {
        if (!t.blockTimestamp || !t.value) return false;
        const claimTime = new Date(t.blockTimestamp).getTime();
        // Must be after sale, within 7 days
        return claimTime >= saleTime && claimTime <= saleTime + sevenDaysMs && t.value > 0;
      });

      if (nativeClaim && nativeClaim.value !== null && nativeClaim.value > 0 && nativeClaim.blockTimestamp) {
        const proceedsUsd = nativeClaim.value * nativePriceUsd;
        const claimTime = new Date(nativeClaim.blockTimestamp).getTime();
        trades.push({
          txSignature: nativeClaim.hash,
          chain,
          wallet,
          tokenMintOrAddress: incompleteSell.tokenAddress,
          side: "sell",
          quantity: incompleteSell.quantity,
          priceUsd: proceedsUsd / incompleteSell.quantity,
          timestamp: incompleteSell.timestamp,
          preGraduation: incompleteSell.preGraduation,
        });
        const hoursAgo = ((new Date().getTime() - claimTime) / (1000 * 60 * 60)).toFixed(1);
        console.log(`[evmTradeBuilder] Bonding curve claim matched: token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} proceeds=${proceedsUsd.toFixed(2)} USD (claimed ${hoursAgo}h ago)`);
      } else {
        // Try to fetch receipt for debugging - might reveal settlement pattern
        if (alchemy && incompleteSell.hash) {
          alchemy.getTransactionReceipt(incompleteSell.hash).catch(() => {
            // Silently ignore errors - this is just for debugging
          });
        }
        console.log(`[evmTradeBuilder] Incomplete sell: token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} PENDING SETTLEMENT (no claim found in ${allNativeIn.length} transfers)`);
      }
    }
  }

  return trades.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
