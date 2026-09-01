const HELIUS_ENHANCED_TX_BASE = "https://api.helius.xyz/v0";
const HELIUS_RPC_BASE = "https://mainnet.helius-rpc.com";
const FETCH_TIMEOUT_MS = 10_000;

/** Enhanced Transaction History page size. 100 is Helius's max per request. */
const PAGE_LIMIT = 100;

/**
 * Hard cap on how many pages of history we'll paginate back through per
 * request. This is a request-time API call serving an HTTP response, not a
 * background indexer -- a wallet with years of pump.fun degen trading can
 * have tens of thousands of signatures, and walking all of them on every
 * `GET /wallet/:address/pnl` call would be both slow and expensive. 500
 * most-recent transactions (not just swaps -- see the no-`type`-filter note
 * below) is enough to reconstruct accurate PnL for the vast majority of
 * real wallets checked during validation (see the hand-off report); a
 * wallet with more history than that will have realized PnL understated
 * for whatever activity falls outside the window. A real follow-up here is
 * a background indexer that persists full history incrementally instead of
 * re-fetching per request -- out of scope for this pass.
 */
const MAX_PAGES = 5;

export interface HeliusTokenTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  tokenAmount: number;
  mint: string;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  amount: number;
}

export interface HeliusTokenBalanceChange {
  userAccount: string;
  mint: string;
  rawTokenAmount: { tokenAmount: string; decimals: number };
}

export interface HeliusAccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: HeliusTokenBalanceChange[];
}

export interface HeliusEnhancedTransaction {
  signature: string;
  type: string;
  source: string;
  timestamp: number; // unix seconds
  feePayer: string;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
  accountData: HeliusAccountData[];
  transactionError: unknown;
}

export interface HeliusAsset {
  id: string;
  content?: { metadata?: { symbol?: string; name?: string } };
}

function withTimeout(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

/**
 * Fetches recent parsed SWAP transactions for a wallet via Helius's
 * Enhanced Transaction History API (`GET /v0/addresses/:address/transactions`),
 * paginating backwards (via the `before` signature cursor) until either
 * MAX_PAGES is hit or the wallet runs out of history.
 *
 * Deliberately does NOT pass Helius's `type=SWAP` server-side filter,
 * despite the name -- discovered during hand-validation of real wallets
 * (see the Item 2 hand-off report) that pump.fun's "create token + make the
 * initial dev buy" instruction is classified by Helius as `type: "CREATE"`,
 * not `"SWAP"`, even though it's a real priced buy fill with the exact same
 * accountData shape. A wallet that launches-and-dumps its own tokens (a
 * very common pump.fun pattern) would have every one of its buys silently
 * dropped by a server-side `type=SWAP` filter, making every later sell look
 * like 100%-margin profit with no cost basis -- a systematic overstatement
 * this project specifically exists to avoid. Helius's `type` filter also
 * doesn't accept a comma-separated list (`type=SWAP,CREATE` errors), so the
 * fix is to fetch unfiltered and let mapTrades.ts decide which transaction
 * types represent priced fills (`SWAP` and `CREATE`) vs. noise (plain
 * transfers, `UNKNOWN`, NFT activity, etc.) to skip.
 *
 * Returns an empty array (rather than throwing) for a malformed address,
 * an address with zero transaction history, or a transient API error --
 * callers treat "no trades found" as a valid, zeroed-out result rather
 * than a hard failure. See SolanaProvider.
 */
export async function fetchRecentSwaps(
  address: string,
  apiKey: string,
): Promise<HeliusEnhancedTransaction[]> {
  const results: HeliusEnhancedTransaction[] = [];
  let before: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${HELIUS_ENHANCED_TX_BASE}/addresses/${address}/transactions`);
    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (before) url.searchParams.set("before", before);

    let res: Response;
    try {
      res = await fetch(url, { signal: withTimeout() });
    } catch {
      break;
    }
    if (!res.ok) break;

    let batch: unknown;
    try {
      batch = await res.json();
    } catch {
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    const typedBatch = batch as HeliusEnhancedTransaction[];
    results.push(...typedBatch);

    const last = typedBatch[typedBatch.length - 1];
    if (!last?.signature || typedBatch.length < PAGE_LIMIT) break;
    before = last.signature;
  }

  return results;
}

/**
 * Batch token-metadata lookup (symbol/name) via Helius's DAS `getAssetBatch`
 * RPC method, used purely to give positions a human-readable `token` label
 * instead of a raw mint address. Missing/failed lookups fall back to a
 * shortened mint address in the caller, so this never blocks PnL math.
 */
export async function fetchAssetMetadata(
  mints: string[],
  apiKey: string,
): Promise<Map<string, HeliusAsset>> {
  const map = new Map<string, HeliusAsset>();
  if (mints.length === 0 || !apiKey) return map;

  try {
    const res = await fetch(`${HELIUS_RPC_BASE}/?api-key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bagged-asset-batch",
        method: "getAssetBatch",
        params: { ids: mints },
      }),
      signal: withTimeout(),
    });
    if (!res.ok) return map;

    const body = (await res.json()) as { result?: HeliusAsset[] };
    for (const asset of body.result ?? []) {
      if (asset?.id) map.set(asset.id, asset);
    }
  } catch {
    // Metadata is cosmetic (a display label) -- swallow and fall back.
  }

  return map;
}
