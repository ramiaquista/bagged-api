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
  for (const [hash, group] of byHash) {
    const nativeOut = group.filter((t) => t.category === "external" && t.from === walletLc);
    const nativeIn = group.filter((t) => t.category === "external" && t.to === walletLc);
    const tokenOut = group.filter((t) => t.category === "erc20" && t.from === walletLc && t.tokenAddress);
    const tokenIn = group.filter((t) => t.category === "erc20" && t.to === walletLc && t.tokenAddress);

    const timestamp = group.find((t) => t.blockTimestamp)?.blockTimestamp ?? new Date(0).toISOString();
    const touchesBondingCurve = group.some(
      (t) => (t.to !== null && launchpad.isBondingCurveAddress(t.to)) || launchpad.isBondingCurveAddress(t.from),
    );

    if (nativePriceUsd === null) {
      // No native price available -- nothing in this hash can be priced.
      continue;
    }

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

    if (tokenOut.length === 1 && nativeIn.length >= 1) {
      const token = tokenOut[0]!;
      const quantity = token.value ?? 0;
      const nativeReceived = nativeIn.reduce((sum, t) => sum + (t.value ?? 0), 0);
      if (quantity > 0 && nativeReceived > 0 && token.tokenAddress) {
        trades.push({
          txSignature: hash,
          chain,
          wallet,
          tokenMintOrAddress: token.tokenAddress,
          side: "sell",
          quantity,
          priceUsd: (nativeReceived * nativePriceUsd) / quantity,
          timestamp,
          preGraduation: touchesBondingCurve,
        });
      }
      continue;
    }

    // Token-for-token swaps, multi-leg router transactions, airdrops, etc.
    // -- skipped, see doc comment above.
  }

  return trades.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
