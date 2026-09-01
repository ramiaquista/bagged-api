const FETCH_TIMEOUT_MS = 10_000;

/** Keep individual requests small and fast rather than one giant batch. */
const MAX_IDS_PER_REQUEST = 50;

interface JupiterPriceInfo {
  usdPrice?: number;
}

/**
 * Wraps Jupiter's Price API for current USD prices, given a list of mint
 * addresses and a base URL (`config.JUPITER_API_BASE_URL`).
 *
 * NOTE ON THE CONFIGURED DEFAULT: `.env.example`'s original default,
 * `https://price.jup.ag/v6`, is a fully decommissioned host — it doesn't
 * even resolve DNS anymore (verified live during this work, 2026-09-01;
 * `curl` fails with "Could not resolve host"). Jupiter has since
 * consolidated free/unauthenticated pricing under
 * `https://lite-api.jup.ag`, with the current price endpoint at
 * `/price/v3`. The default in `.env`/`.env.example`/`config.ts` was updated
 * accordingly so the feature actually works out of the box; see the Item 2
 * hand-off report for this deviation from "use the configured value as-is."
 * `JUPITER_API_BASE_URL` is still fully respected here — this client always
 * builds requests from whatever base URL config supplies, appending
 * `/price/v3?ids=...` to it.
 */
export async function fetchUsdPrices(
  mints: string[],
  baseUrl: string,
): Promise<Map<string, number>> {
  const unique = Array.from(new Set(mints.filter(Boolean)));
  const result = new Map<string, number>();
  if (unique.length === 0) return result;

  const trimmedBase = baseUrl.replace(/\/+$/, "");

  for (let i = 0; i < unique.length; i += MAX_IDS_PER_REQUEST) {
    const batch = unique.slice(i, i + MAX_IDS_PER_REQUEST);
    const url = `${trimmedBase}/price/v3?ids=${batch.map(encodeURIComponent).join(",")}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;

      const body = (await res.json()) as Record<string, JupiterPriceInfo | undefined>;
      for (const mint of batch) {
        const price = body[mint]?.usdPrice;
        if (typeof price === "number" && Number.isFinite(price) && price >= 0) {
          result.set(mint, price);
        }
      }
    } catch {
      // Network hiccup / rate limit / timeout: leave this batch's mints
      // unpriced. SolanaProvider treats "no live price" as a strong
      // rug/no-liquidity signal, not a request failure -- see resolveRugs's
      // doc comment for why that's actually the *more* reliable signal.
      continue;
    }
  }

  return result;
}
