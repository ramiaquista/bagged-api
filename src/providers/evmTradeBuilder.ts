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
/**
 * hood.fun's router (the contract the wallet's buy/sell transaction is
 * actually sent to, e.g. Robinhood Chain 0x65050a9b...) emits its own
 * trade-settlement event reporting the exact token amount and native (ETH)
 * amount for the whole multi-hop route in one place:
 *
 *   event ???(address indexed wallet, address indexed wallet2, address indexed referrer)
 *   data: two uint256 words -- one is the ERC-20 token amount, the other is
 *   the native amount. Confirmed by decoding real Robinhood Chain buys and
 *   sells: buys put native first then token; sells put token first then
 *   native. Rather than hardcode that order (fragile if it varies by
 *   direction or version), we identify the token word by matching it
 *   against the already-known ERC-20 transfer quantity for this same
 *   transaction and treat the other word as native -- self-verifying, and
 *   correct regardless of word order.
 *
 * This replaces reading the internal pool Swap event (below), which only
 * reflects one hop of what is often a multi-hop route (token -> internal
 * wrapped-native -> ... -> native) and does not, by itself, distinguish
 * the final proceeds from an intermediate hop's amount -- see README for
 * how that previously produced proceeds off by 5-10x.
 */
const ROUTER_TRADE_EVENT_SIG = "0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a";
const RELATIVE_MATCH_TOLERANCE = 0.001; // 0.1% -- covers float rounding in Alchemy's decimal-adjusted transfer values

function relativeDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
}

function parseRouterTradeEvent(
  logs: Array<{ topics: string[]; data: string; address: string }>,
  wallet: string,
  knownTokenQuantity: number,
): number | null {
  const walletTopic = "0x" + wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== ROUTER_TRADE_EVENT_SIG) continue;
    if (log.topics[1]?.toLowerCase() !== walletTopic && log.topics[2]?.toLowerCase() !== walletTopic) continue;

    const body = log.data.slice(2);
    if (body.length < 128) continue;

    try {
      const word0 = Number(BigInt("0x" + body.slice(0, 64))) / 1e18;
      const word1 = Number(BigInt("0x" + body.slice(64, 128))) / 1e18;

      if (relativeDiff(word0, knownTokenQuantity) < RELATIVE_MATCH_TOLERANCE) return word1;
      if (relativeDiff(word1, knownTokenQuantity) < RELATIVE_MATCH_TOLERANCE) return word0;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * hood.fun's router also emits a per-trade volume-rebate event, paid in
 * native currency directly to the trader on top of the swap itself (both
 * buys and sells carry one, worth ~1% of the trade). Confirmed against
 * GMGN's own numbers: proceeds = router trade event's native amount +
 * this rebate lands within a few cents of GMGN across multiple real
 * sells, where leaving it out consistently undercounts by that same ~1%.
 */
const TRADE_REBATE_EVENT_SIG = "0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92";

function parseTradeRebate(logs: Array<{ topics: string[]; data: string; address: string }>, wallet: string): number {
  const walletTopic = "0x" + wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  let total = 0;
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRADE_REBATE_EVENT_SIG) continue;
    if (log.topics[1]?.toLowerCase() !== walletTopic && log.topics[2]?.toLowerCase() !== walletTopic) continue;
    const body = log.data.slice(2);
    if (body.length < 64) continue;
    try {
      total += Number(BigInt("0x" + body.slice(0, 64))) / 1e18;
    } catch {
      continue;
    }
  }
  return total;
}

/**
 * The gas the wallet itself paid for a transaction -- a real cost of
 * trading that Alchemy's asset-transfer feed never reports (gas is
 * deducted by the protocol, not moved as a transfer). Confirmed this
 * matters here: leaving it out made every realized-PnL day noticeably
 * less negative (or less positive) than GMGN's, by exactly the wallet's
 * own gas spend for that day's transactions.
 */
function gasFeeEth(receipt: { gasUsed: string; effectiveGasPrice: string }): number {
  try {
    const wei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    return Number(wei) / 1e18;
  } catch {
    return 0;
  }
}

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

  // Price each trade at the native/USD rate when it actually happened, not
  // today's rate -- a wallet with trades spread over days/weeks previously
  // priced every single one off one flat "current price" snapshot, which
  // silently made every historical buy/sell wrong by whatever ETH moved
  // since. Bucketed by 5 minutes so trades close together in time (a buy
  // immediately followed by a sell, common on bonding curves) share one
  // Prices API call instead of one each.
  const priceCache = new Map<number, Promise<number | null>>();
  async function priceAt(timestamp: string): Promise<number> {
    if (alchemy) {
      const bucket = Math.floor(new Date(timestamp).getTime() / (5 * 60 * 1000));
      let pending = priceCache.get(bucket);
      if (!pending) {
        pending = alchemy.getHistoricalNativePriceUsd(timestamp).catch(() => null);
        priceCache.set(bucket, pending);
      }
      const historical = await pending;
      if (historical !== null) return historical;
    }
    return nativePriceUsd ?? 0;
  }

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

  if (nativePriceUsd === null && !alchemy) {
    return trades; // No pricing available at all
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
    const priceUsd = await priceAt(timestamp);

    // BUY: token in + native out
    if (tokenIn.length === 1 && nativeOut.length >= 1) {
      const token = tokenIn[0]!;
      const quantity = token.value ?? 0;
      let nativeSpent = nativeOut.reduce((sum, t) => sum + (t.value ?? 0), 0);

      // The router pays the trader a volume rebate on buys too (same event
      // as the one added to sell proceeds -- see parseTradeRebate). The
      // trader's real net cost is what they sent minus what came back,
      // plus the gas they themselves paid to execute the buy.
      if (alchemy && nativeSpent > 0) {
        const receipt = await alchemy.getTransactionReceipt(hash);
        if (receipt?.logs) {
          const rebate = parseTradeRebate(receipt.logs, wallet);
          nativeSpent = Math.max(0, nativeSpent - rebate + gasFeeEth(receipt));
        }
      }

      console.log(`[evmTradeBuilder] Buy detected: token=${token.asset ?? token.tokenAddress?.slice(0, 6)} qty=${quantity.toFixed(2)} nativeSpent=${nativeSpent.toFixed(6)} costUsd=${(nativeSpent * priceUsd).toFixed(2)} (priceAtTrade=${priceUsd.toFixed(2)})`);
      if (quantity > 0 && nativeSpent > 0 && token.tokenAddress) {
        trades.push({
          txSignature: hash,
          chain,
          wallet,
          tokenMintOrAddress: token.tokenAddress,
          side: "buy",
          quantity,
          priceUsd: (nativeSpent * priceUsd) / quantity,
          timestamp,
          preGraduation: touchesBondingCurve,
        });
        console.log(`[evmTradeBuilder] Buy recorded: ${token.asset} qty=${quantity.toFixed(2)} costUsd=${(nativeSpent * priceUsd).toFixed(2)}`);
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
            proceedsUsd = nativeReceived * priceUsd;
          }
        }

        // Fallback: check for ERC-20 token proceeds (wrapped native or reward tokens)
        if (proceedsUsd === 0) {
          const tokensIn = group.filter((t) => t.category === "erc20" && t.to === walletLc && t.tokenAddress && t.tokenAddress !== token.tokenAddress);
          if (tokensIn.length >= 1) {
            proceedsUsd = tokensIn.reduce((sum, t) => sum + (t.value ?? 0), 0) * priceUsd;
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
              proceedsUsd = procedsFromRecipient.reduce((sum, t) => sum + ((t.value ?? 0) * priceUsd), 0);
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

  // PASS 2: Resolve sells whose proceeds don't appear as a simple transfer
  // in the same transaction (hood.fun-style bonding curves settle the
  // native leg internally rather than transferring it straight to the
  // EOA). Tried in order of reliability -- each one only runs if the one
  // before it didn't produce an answer:
  //
  //   1. The router's own trade-settlement event, read straight out of the
  //      SAME transaction's receipt and self-verified against the known
  //      token quantity (see parseRouterTradeEvent). This is ground truth
  //      when it's present -- no cross-transaction guessing involved.
  //   2. The internal pool Swap event, for bonding curves without (1) --
  //      less reliable since it can reflect just one hop of a multi-hop
  //      route, capped at MAX_NATIVE_PROCEEDS to reject reward-token noise.
  //   3. Last resort: a later incoming native transfer. This is a guess --
  //      it can misattribute an unrelated incoming transfer as this sale's
  //      proceeds -- so it only runs once (1) and (2) have both come up
  //      empty.
  if (incompleteSells.length > 0) {
    for (const incompleteSell of incompleteSells) {
      let resolvedNative: number | null = null;
      let sellGasFee = 0;

      if (alchemy) {
        const receipt = await alchemy.getTransactionReceipt(incompleteSell.hash);

        if (receipt?.logs) {
          sellGasFee = gasFeeEth(receipt);
          resolvedNative = parseRouterTradeEvent(receipt.logs, wallet, incompleteSell.quantity);
          if (resolvedNative !== null && resolvedNative > 0) {
            resolvedNative += parseTradeRebate(receipt.logs, wallet);
            console.log(`[evmTradeBuilder] ✅ Router trade event: token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} proceedsNative=${resolvedNative.toFixed(6)} (incl. volume rebate)`);
          } else {
            resolvedNative = null;
            const swapAmounts = parseSwapEventFromLogs(receipt.logs, incompleteSell.tokenAddress);
            if (swapAmounts) {
              const THRESHOLD = 0.0001; // Treat as "zero" if smaller than this
              const a0Significant = swapAmounts.amount0 > THRESHOLD;
              const a1Significant = swapAmounts.amount1 > THRESHOLD;

              let proceeds = 0;
              if (a0Significant && a1Significant) proceeds = Math.max(swapAmounts.amount0, swapAmounts.amount1);
              else if (a0Significant) proceeds = swapAmounts.amount0;
              else if (a1Significant) proceeds = swapAmounts.amount1;

              // Reject reward-token noise: native currency swaps are
              // typically well under this for small bonding-curve sales.
              const MAX_NATIVE_PROCEEDS = 10;
              if (proceeds > 0 && proceeds < MAX_NATIVE_PROCEEDS) {
                resolvedNative = proceeds;
                console.log(`[evmTradeBuilder] Pool swap event (fallback): token=${incompleteSell.asset} amount0=${swapAmounts.amount0.toFixed(6)} amount1=${swapAmounts.amount1.toFixed(6)} proceeds=${proceeds.toFixed(6)}`);
              }
            }
          }
        }
      }

      if (resolvedNative !== null && resolvedNative > 0) {
        const netNative = Math.max(0, resolvedNative - sellGasFee);
        const priceUsd = await priceAt(incompleteSell.timestamp);
        const proceedsUsd = netNative * priceUsd;
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
        console.log(`[evmTradeBuilder] Sell recorded: ${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} proceedsUsd=${proceedsUsd.toFixed(2)}`);
        continue;
      }

      // Last resort: a later incoming native transfer close enough in time
      // to plausibly be this sale's claim.
      const nativeClaim = transfers.find((t) => {
        if (t.category !== "external" || t.to !== walletLc || !t.blockTimestamp || !t.value) return false;
        const saleTime = new Date(incompleteSell.timestamp).getTime();
        const claimTime = new Date(t.blockTimestamp).getTime();
        return claimTime >= saleTime && t.value > 0;
      });

      if (nativeClaim?.value && nativeClaim.blockTimestamp) {
        const priceUsd = await priceAt(nativeClaim.blockTimestamp);
        const proceedsUsd = nativeClaim.value * priceUsd;
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
        console.log(`[evmTradeBuilder] Bonding curve claim (last resort): token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} proceedsUsd=${proceedsUsd.toFixed(2)}`);
        continue;
      }

      // Genuinely couldn't find any proceeds for this token leaving the
      // wallet -- record it as a transfer_out rather than silently
      // dropping it. Without this, a buy that's later moved out this way
      // (a plain transfer to another address, or a sell we truly can't
      // price) left its cost basis stuck forever: quantityHeld never
      // decremented (the tokens aren't actually held anymore) and, in a
      // caller computing realized PnL as proceeds-minus-total-bought, that
      // stuck cost showed up as a full loss it never actually was.
      trades.push({
        txSignature: incompleteSell.hash,
        chain,
        wallet,
        tokenMintOrAddress: incompleteSell.tokenAddress,
        side: "transfer_out",
        quantity: incompleteSell.quantity,
        priceUsd: 0,
        timestamp: incompleteSell.timestamp,
        preGraduation: incompleteSell.preGraduation,
      });
      console.log(`[evmTradeBuilder] Recorded as transfer_out (no resolvable proceeds): token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)}`);
    }
  }

  return trades.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
