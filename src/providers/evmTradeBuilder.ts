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

// Note: Robinhood Chain bonding curves (hood.fun) do not return proceeds via direct transfers.
// Proceeds are held in escrow and require manual claiming or off-chain settlement verification.
// To match GMGN's pricing, we would need to:
// 1. Query PoolManager contract for pool reserves at time of sale
// 2. Use Uniswap V4 math to calculate expected proceeds
// 3. Parse swap events from transaction receipts
// 4. Integrate with hood.fun API if available
//
// For now, incomplete sales show $0 and are marked "ESCROW" in logs.

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
      } else {
        // No claim found - proceeds are locked in escrow
        // For now, skip the trade (can't price without claim)
        // Future: Query pool contracts directly for reserve-based pricing
        console.log(`[evmTradeBuilder] Incomplete sell: token=${incompleteSell.asset} qty=${incompleteSell.quantity.toFixed(2)} ESCROW (proceeds not returned to wallet - pool reserves locked)`);
      }
    }
  }

  return trades.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
