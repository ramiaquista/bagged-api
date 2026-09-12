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

/**
 * Parse Uniswap V4 Swap event from transaction logs.
 *
 * Swap event (PoolManager): Swap(address indexed sender, int256 amount0Delta, int256 amount1Delta, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
 * Topic: 0x71d78e8f4fbff2dff101e66d247c5ab3e847a10786ccd2f1cfc422a25b1b6c5f
 *
 * For Robinhood Chain / hood.fun:
 * - amount0Delta: change in token0 (positive = into pool, negative = out of pool)
 * - amount1Delta: change in token1
 * We extract the deltas to get actual swap amounts.
 */
function parseSwapEventFromLogs(
  logs: Array<{ topics: string[]; data: string; address: string }>,
  tokenAddress?: string,
): { amount0: number; amount1: number } | null {
  try {
    // Possible Swap event signatures (different implementations)
    const SWAP_SIGS = [
      "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", // hood.fun bonding curve Swap
      "0x71d78e8f4fbff2dff101e66d247c5ab3e847a10786ccd2f1cfc422a25b1b6c5f", // Uniswap V4 PoolManager
      "0xc42079f94a6350d7e6235f29174924f7e02e8631e695c17466f7d159d07f4119", // Uniswap V3
    ];

    // DEBUG: Log all events to identify the actual signatures
    const uniqueSigs = new Set<string>();
    for (const log of logs) {
      if (log.topics[0]) {
        uniqueSigs.add(log.topics[0]);
      }
    }
    if (uniqueSigs.size > 0) {
      console.log(`[evmTradeBuilder] Event signatures in receipt: ${Array.from(uniqueSigs).join(", ")}`);
    }

    // Find the Swap event with the largest non-zero proceeds
    // (Sometimes there are multiple Swap events; we want the main one)
    let bestSwap: { amount0: number; amount1: number } | null = null;
    let maxProceeds = 0;

    for (const log of logs) {
      if (!log.topics[0] || !SWAP_SIGS.includes(log.topics[0])) continue;

      try {
        // Swap event data: amount0Delta (32 bytes), amount1Delta (32 bytes), sqrtPriceX96 (32 bytes), liquidity (16 bytes), tick (3 bytes)
        // We need first two 32-byte values: amount0 and amount1
        const amount0Hex = log.data.slice(0, 66); // 0x + 64 hex chars
        const amount1Hex = "0x" + log.data.slice(66, 130); // next 64 hex chars

        // Parse as signed 256-bit integers (int256) - can be negative for swaps
        // Need to handle two's complement for negative values
        const parseSignedInt256 = (hex: string): bigint => {
          const num = BigInt(hex);
          const maxUint256 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
          const maxInt256 = BigInt("0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");

          // If the value is larger than max int256, it's negative in two's complement
          return num > maxInt256 ? num - (maxUint256 + BigInt(1)) : num;
        };

        let amount0Bigint = parseSignedInt256(amount0Hex);
        let amount1Bigint = parseSignedInt256(amount1Hex);

        let amount0 = Number(amount0Bigint) / 1e18;
        let amount1 = Number(amount1Bigint) / 1e18;

        // Take absolute values - we care about magnitude of swap
        amount0 = Math.abs(amount0);
        amount1 = Math.abs(amount1);

        // For hood.fun bonding curves, amount0 is typically the proceeds (native asset out)
        // and amount1 might be fees/intermediates. Pick the smaller value when both are present.
        // This avoids inflating proceeds by picking secondary events.
        let proceeds = 0;
        if (amount0 > 0 && amount1 > 0) {
          // Both are non-zero: pick the smaller one (typically proceeds, not fees)
          proceeds = Math.min(amount0, amount1);
        } else {
          // One is zero: pick whichever is non-zero
          proceeds = Math.max(amount0, amount1);
        }

        if (proceeds > maxProceeds && proceeds > 0) {
          maxProceeds = proceeds;
          bestSwap = { amount0, amount1 };
          console.log(`[evmTradeBuilder] Better Swap event: amount0=${amount0.toFixed(6)} amount1=${amount1.toFixed(6)} proceeds=${proceeds.toFixed(6)}`);
        }
      } catch (e) {
        // Try next log
        continue;
      }
    }

    if (bestSwap) {
      console.log(`[evmTradeBuilder] Selected Swap event: amount0=${bestSwap.amount0.toFixed(6)} amount1=${bestSwap.amount1.toFixed(6)}`);
      return bestSwap;
    }
  } catch (err) {
    console.error("[evmTradeBuilder] Failed to parse swap events:", err);
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
      console.log(`[evmTradeBuilder] Buy detected: token=${token.asset ?? token.tokenAddress?.slice(0, 6)} qty=${quantity.toFixed(2)} nativeSpent=${nativeSpent.toFixed(6)} costUsd=${(nativeSpent * nativePriceUsd).toFixed(2)}`);
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
        console.log(`[evmTradeBuilder] Buy recorded: ${token.asset} qty=${quantity.toFixed(2)} costUsd=${(nativeSpent * nativePriceUsd).toFixed(2)}`);
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
  // Robinhood Chain bonding curves don't return proceeds via simple transfers
  // Proceeds are held in escrow or require special settlement
  if (incompleteSells.length > 0) {
    const allNativeIn = transfers.filter((t) => t.category === "external" && t.to === walletLc);

    for (const incompleteSell of incompleteSells) {
      // Try to find claim transactions
      const nativeClaim = allNativeIn.find((t) => {
        if (!t.blockTimestamp || !t.value) return false;
        // Look for native transfers after sale, no time limit
        const saleTime = new Date(incompleteSell.timestamp).getTime();
        const claimTime = new Date(t.blockTimestamp).getTime();
        return claimTime >= saleTime && t.value > 0;
      });

      if (nativeClaim && nativeClaim.value !== null && nativeClaim.value > 0 && nativeClaim.blockTimestamp) {
        // Found a claim transaction
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
        console.log(`[evmTradeBuilder] Bonding curve claim: token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} proceeds=${proceedsUsd.toFixed(2)} USD (claimed ${hoursAgo}h ago)`);
      } else if (alchemy) {
        // No claim found - try to parse swap event from transaction receipt
        // Uniswap V4 Swap events contain actual amount0/amount1 deltas
        const receipt = await alchemy.getTransactionReceipt(incompleteSell.hash);

        if (receipt && receipt.logs) {
          const swapAmounts = parseSwapEventFromLogs(receipt.logs, incompleteSell.tokenAddress);
          console.log(`[evmTradeBuilder] DEBUG: swapAmounts=${swapAmounts ? JSON.stringify(swapAmounts) : "null"}`);

          if (swapAmounts) {
            // For hood.fun bonding curves, when both amounts are non-zero,
            // pick the smaller one (typically proceeds). When only one is non-zero, pick that.
            let proceeds = 0;
            if (swapAmounts.amount0 > 0 && swapAmounts.amount1 > 0) {
              proceeds = Math.min(swapAmounts.amount0, swapAmounts.amount1);
            } else {
              proceeds = Math.max(swapAmounts.amount0, swapAmounts.amount1);
            }
            console.log(`[evmTradeBuilder] Swap event: token=${incompleteSell.asset} amount0=${swapAmounts.amount0.toFixed(6)} amount1=${swapAmounts.amount1.toFixed(6)} proceeds=${proceeds.toFixed(6)} (nativePriceUsd=${nativePriceUsd})`);

            // Filter out reward tokens: if proceeds > 10 RHO, it's likely a reward token (AF, GD, etc)
            // not native currency. Native currency swaps are typically < 1 RHO for small bonding curve sales.
            const MAX_NATIVE_PROCEEDS = 10; // RHO tokens
            if (proceeds > 0 && proceeds < MAX_NATIVE_PROCEEDS) {
              const proceedsUsd = proceeds * nativePriceUsd;
              trades.push({
                txSignature: incompleteSell.hash,
                chain,
                wallet,
                tokenMintOrAddress: incompleteSell.tokenAddress,
                side: "sell",
                quantity: incompleteSell.quantity,
                priceUsd: proceedsUsd / incompleteSell.quantity,
                timestamp: incompleteSell.timestamp,
                preGraduation: incompleteSell.preGraduation,
              });
              console.log(`[evmTradeBuilder] ✅ Swap event recorded: token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} proceedsNative=${proceeds.toFixed(6)} proceedsUsd=${proceedsUsd.toFixed(2)}`);
              continue;
            } else {
              console.log(`[evmTradeBuilder] ❌ Swap event FILTERED: token=${incompleteSell.asset} proceeds=${proceeds.toFixed(6)} (outside range 0-10 RHO)`);
            }
          }
        }

        // Fallback: log as escrow if we can't parse event
        console.log(`[evmTradeBuilder] Incomplete sell: token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} ESCROW (no swap event found in receipt)`);
      } else {
        console.log(`[evmTradeBuilder] Incomplete sell: token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} ESCROW (alchemy client not available)`);
      }
    }
  }

  return trades.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
