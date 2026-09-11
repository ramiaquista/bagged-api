import type { Trade } from "../pnl-engine/index.js";
import type { Chain } from "../schemas/chain.js";
import type { AssetTransfer } from "./alchemy/client.js";
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

export function buildTradesFromTransfers(
  wallet: string,
  chain: Exclude<Chain, "solana">,
  transfers: AssetTransfer[],
  nativePriceUsd: number | null,
  launchpad: LaunchpadResolver,
): Trade[] {
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
  // Only match native currency claims; reward tokens are unreliable without price data
  if (incompleteSells.length > 0) {
    const allNativeIn = transfers.filter((t) => t.category === "external" && t.to === walletLc);

    for (const incompleteSell of incompleteSells) {
      const saleTime = new Date(incompleteSell.timestamp).getTime();
      const fifteenMinutesMs = 15 * 60 * 1000;

      // Look for native currency claims shortly after the sale
      // Filter to claims that look reasonable (within ~10x the cost basis as a sanity check)
      const nativeClaim = allNativeIn.find((t) => {
        if (!t.blockTimestamp || !t.value) return false;
        const claimTime = new Date(t.blockTimestamp).getTime();
        // Within 15 min after sale, value > 0
        return claimTime >= saleTime && claimTime <= saleTime + fifteenMinutesMs && t.value > 0;
      });

      if (nativeClaim && nativeClaim.value !== null && nativeClaim.value > 0) {
        const proceedsUsd = nativeClaim.value * nativePriceUsd;
        trades.push({
          txSignature: nativeClaim.hash,
          chain,
          wallet,
          tokenMintOrAddress: incompleteSell.tokenAddress,
          side: "sell",
          quantity: incompleteSell.quantity,
          priceUsd: proceedsUsd / incompleteSell.quantity,
          timestamp: incompleteSell.timestamp, // Use original sale time for matching
          preGraduation: incompleteSell.preGraduation,
        });
        console.log(`[evmTradeBuilder] Multi-tx native claim: token=${incompleteSell.asset} qty=${incompleteSell.quantity} proceeds=${proceedsUsd.toFixed(2)}`);
      }
      // Note: Reward token claims (COIN, AF, etc.) are skipped because we don't have
      // their prices and using native price as proxy leads to wildly incorrect calculations.
      // Future: fetch actual prices for common reward tokens on each chain.
    }
  }

  return trades.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
