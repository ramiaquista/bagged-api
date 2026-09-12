const FETCH_TIMEOUT_MS = 10_000;
const KLINES_URL = "https://api.binance.com/api/v3/klines";
/** Binance's hard cap on candles per request. */
const MAX_CANDLES = 1000;

export interface PricePoint {
  timestampMs: number;
  priceUsd: number;
}

/**
 * Historical SOL/USD price, sourced from Binance's public market-data API
 * (SOLUSDT spot klines) -- no API key, no rate-limit auth, free.
 *
 * Why Binance and not Jupiter: Jupiter's Price API (used elsewhere in this
 * provider for *current* prices) only serves the current price, no
 * historical endpoint at any tier. CoinGecko's free tier rejects historical
 * range queries outright (verified live: "exceeds the allowed time range...
 * Upgrade to a paid plan" even for a 2-day-old range). Binance's public
 * klines endpoint has no such restriction and returns real 1-minute
 * candles for any range SOLUSDT has traded, which easily covers memecoin
 * trading history.
 *
 * Every Solana trade here is SOL-denominated (see mapTrades.ts), so pricing
 * off SOLUSDT is the same trade-off already made for the *current*-price
 * path (USDT ~= USD) -- consistent, not a new approximation.
 *
 * One request per wallet load covering the whole [startMs, endMs] span,
 * with candle interval scaled up as the span widens so a single request
 * never needs more than MAX_CANDLES points -- a multi-week wallet history
 * still costs one HTTP call, just at coarser (but still far better than
 * "today's price") granularity.
 */
export async function fetchHistoricalSolPriceSeries(startMs: number, endMs: number): Promise<PricePoint[]> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const spanMs = endMs - startMs;
  const interval = pickInterval(spanMs);

  const url = new URL(KLINES_URL);
  url.searchParams.set("symbol", "SOLUSDT");
  url.searchParams.set("interval", interval);
  url.searchParams.set("startTime", String(Math.floor(startMs)));
  url.searchParams.set("endTime", String(Math.ceil(endMs)));
  url.searchParams.set("limit", String(MAX_CANDLES));

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`[Binance] Klines fetch failed: HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];

    // Kline shape: [openTime, open, high, low, close, volume, closeTime, ...]
    return body
      .map((c): PricePoint | null => {
        if (!Array.isArray(c) || c.length < 5) return null;
        const closePrice = Number(c[4]);
        const openTime = Number(c[0]);
        if (!Number.isFinite(closePrice) || !Number.isFinite(openTime)) return null;
        return { timestampMs: openTime, priceUsd: closePrice };
      })
      .filter((p): p is PricePoint => p !== null);
  } catch (err) {
    console.error(`[Binance] Klines fetch error:`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** Nearest-timestamp price lookup; null if the series is empty. */
export function nearestSolPrice(series: PricePoint[], targetMs: number): number | null {
  if (series.length === 0) return null;
  let best = series[0]!;
  let bestDiff = Math.abs(best.timestampMs - targetMs);
  for (const point of series) {
    const diff = Math.abs(point.timestampMs - targetMs);
    if (diff < bestDiff) {
      best = point;
      bestDiff = diff;
    }
  }
  return best.priceUsd;
}

function pickInterval(spanMs: number): string {
  const spanMinutes = spanMs / 60_000;
  if (spanMinutes <= MAX_CANDLES) return "1m";
  const spanHours = spanMs / 3_600_000;
  if (spanHours <= MAX_CANDLES) return "1h";
  const spanDays = spanMs / 86_400_000;
  if (spanDays <= MAX_CANDLES) return "1d";
  return "1w"; // multi-year wallet history -- coarse, but still real prices, not "today's"
}
