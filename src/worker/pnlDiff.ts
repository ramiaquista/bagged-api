/**
 * Pure diff/threshold logic for the webhook delivery worker
 * (src/worker/webhookWorker.ts) -- deliberately dependency-free (no DB, no
 * network) so it's cheap to unit test exhaustively.
 *
 * "PnL % change" is defined as the percentage change in `total_pnl_usd`
 * (realized + unrealized, matching WalletPnl -- see src/schemas/pnl.ts)
 * between a wallet's immediately-prior `pnl_snapshots` row and its
 * just-fetched current value:
 *
 *   changePct = (current - previous) / abs(previous) * 100
 *
 * Two edge cases fall out of dividing by the previous value:
 *   - No previous snapshot at all (first time this wallet has ever been
 *     checked): there's nothing to diff against yet, so this never counts
 *     as a crossing -- the first check only establishes a baseline.
 *   - Previous total was exactly 0: a plain percentage change is undefined
 *     (division by zero). Treated as "any movement away from zero is a
 *     crossing" -- going from a wash to any nonzero PnL is exactly the
 *     kind of event this feature exists to notify about, and reporting an
 *     infinite/NaN percentage would be worse than being explicit about it.
 */

/**
 * Percentage change from `previousTotalPnlUsd` to `currentTotalPnlUsd`.
 * Returns `null` when there's no previous snapshot to diff against, or
 * when a real percentage can't be computed (previous total was exactly 0
 * -- see module doc comment).
 */
export function computePnlChangePct(previousTotalPnlUsd: number | null, currentTotalPnlUsd: number): number | null {
  if (previousTotalPnlUsd === null) return null;
  if (previousTotalPnlUsd === 0) return null;
  return ((currentTotalPnlUsd - previousTotalPnlUsd) / Math.abs(previousTotalPnlUsd)) * 100;
}

/**
 * Whether a wallet's PnL % change since its last snapshot crosses
 * `thresholdPct` (`|changePct| >= thresholdPct`). `thresholdPct` is always
 * positive (see RegisterWebhookSchema in src/schemas/webhook.ts), so this
 * fires on movement in either direction -- a webhook subscriber cares about
 * a wallet's PnL swinging by more than X%, not just going up or down.
 */
export function hasCrossedThreshold(
  previousTotalPnlUsd: number | null,
  currentTotalPnlUsd: number,
  thresholdPct: number,
): boolean {
  if (previousTotalPnlUsd === null) return false;
  if (previousTotalPnlUsd === 0) return currentTotalPnlUsd !== 0;
  const changePct = computePnlChangePct(previousTotalPnlUsd, currentTotalPnlUsd);
  return changePct !== null && Math.abs(changePct) >= thresholdPct;
}
