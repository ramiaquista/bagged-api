import type { Chain } from "../../schemas/chain.js";
import { ALCHEMY_NETWORK, NATIVE_SYMBOL } from "./networks.js";

/** One asset movement, normalized from Alchemy's `alchemy_getAssetTransfers` shape. */
export interface AssetTransfer {
  hash: string;
  from: string;
  to: string | null;
  /** Token symbol / asset name as reported by Alchemy (e.g. "BNB", "CHAD"). */
  asset: string | null;
  category: "external" | "erc20" | string;
  /** Already decimal-adjusted by Alchemy -- a human-readable quantity, not raw wei/base units. */
  value: number | null;
  /** ERC-20 contract address, present only for category "erc20". */
  tokenAddress: string | null;
  blockTimestamp: string | null;
}

/**
 * What EvmProvider needs from Alchemy, as an interface so tests can inject
 * a fake implementation instead of making real network calls.
 */
export interface AlchemyClient {
  /** Every native + ERC-20 transfer in or out of `address`, most recent first. */
  getAllTransfers(address: string): Promise<AssetTransfer[]>;
  getTokenPriceUsd(tokenAddress: string): Promise<number | null>;
  getNativePriceUsd(): Promise<number | null>;
  /** Get transaction receipt with logs for parsing swap events. */
  getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null>;
  /** Query ERC-20 balanceOf at a specific block height. */
  getTokenBalance(tokenAddress: string, holder: string, blockNumber: string): Promise<number | null>;
}

export interface TransactionReceipt {
  transactionHash: string;
  blockNumber: string;
  gasUsed: string;
  logs: Array<{
    topics: string[];
    data: string;
    address: string;
  }>;
}

export interface PoolReserves {
  token0: string;
  token1: string;
  reserve0: number;
  reserve1: number;
}

const REQUEST_TIMEOUT_MS = 10_000;
// ~1000 transfers/page x 10 pages x 2 directions = up to 20k transfers pulled
// per wallet. Increased from 5 to capture bonding-curve claim transactions that
// may settle asynchronously after the initial sale (e.g., Robinhood Chain).
const MAX_PAGES_PER_DIRECTION = 10;
const PAGE_SIZE_HEX = "0x3e8"; // 1000

interface JsonRpcResponse<T> {
  result?: T;
  error?: { message?: string; code?: number };
}

interface RawAssetTransfer {
  hash: string;
  from: string;
  to: string | null;
  asset: string | null;
  category: string;
  value: number | null;
  rawContract?: { address?: string | null };
  metadata?: { blockTimestamp?: string };
}

interface AssetTransfersResult {
  transfers: RawAssetTransfer[];
  pageKey?: string;
}

interface PricesResponse {
  data?: Array<{
    prices?: Array<{ currency: string; value: string }>;
    error?: string;
  }>;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetchWithTimeout(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`Alchemy HTTP ${res.status} calling ${method}`);
  }
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(`Alchemy RPC error calling ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  if (json.result === undefined) {
    throw new Error(`Alchemy RPC call ${method} returned no result`);
  }
  return json.result;
}

function extractUsd(prices: Array<{ currency: string; value: string }> | undefined): number | null {
  const usd = prices?.find((p) => p.currency === "usd")?.value;
  if (!usd) return null;
  const parsed = Number(usd);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Real Alchemy-backed implementation of AlchemyClient: JSON-RPC + the
 * Enhanced APIs (`alchemy_getAssetTransfers`) for fills, and the Prices API
 * for current USD pricing.
 */
export class AlchemyHttpClient implements AlchemyClient {
  private readonly rpcUrl: string;
  private readonly pricesBaseUrl: string;
  private readonly network: string;
  private readonly nativeSymbol: string;

  constructor(chain: Exclude<Chain, "solana">, apiKey: string) {
    this.network = ALCHEMY_NETWORK[chain];
    this.nativeSymbol = NATIVE_SYMBOL[chain];
    this.rpcUrl = `https://${this.network}.g.alchemy.com/v2/${apiKey}`;
    this.pricesBaseUrl = `https://api.g.alchemy.com/prices/v1/${apiKey}`;
  }

  async getAllTransfers(address: string): Promise<AssetTransfer[]> {
    const raw: RawAssetTransfer[] = [];
    for (const direction of ["fromAddress", "toAddress"] as const) {
      let pageKey: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_DIRECTION; page++) {
        const result = await rpcCall<AssetTransfersResult>(this.rpcUrl, "alchemy_getAssetTransfers", [
          {
            fromBlock: "0x0",
            category: ["external", "erc20"],
            withMetadata: true,
            maxCount: PAGE_SIZE_HEX,
            order: "desc",
            [direction]: address,
            ...(pageKey ? { pageKey } : {}),
          },
        ]);
        raw.push(...result.transfers);
        pageKey = result.pageKey;
        if (!pageKey) break;
      }
    }

    return raw.map((t) => ({
      hash: t.hash,
      from: t.from.toLowerCase(),
      to: t.to ? t.to.toLowerCase() : null,
      asset: t.asset,
      category: t.category,
      value: typeof t.value === "number" ? t.value : null,
      tokenAddress: t.rawContract?.address ? t.rawContract.address.toLowerCase() : null,
      blockTimestamp: t.metadata?.blockTimestamp ?? null,
    }));
  }

  async getTokenPriceUsd(tokenAddress: string): Promise<number | null> {
    const res = await fetchWithTimeout(`${this.pricesBaseUrl}/tokens/by-address`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addresses: [{ network: this.network, address: tokenAddress }] }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as PricesResponse;
    return extractUsd(json.data?.[0]?.prices);
  }

  async getNativePriceUsd(): Promise<number | null> {
    const res = await fetchWithTimeout(
      `${this.pricesBaseUrl}/tokens/by-symbol?symbols=${this.nativeSymbol}`,
      { method: "GET" },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as PricesResponse;
    return extractUsd(json.data?.[0]?.prices);
  }

  async getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null> {
    try {
      const receipt = await rpcCall<{
        transactionHash: string;
        blockNumber: string;
        gasUsed: string;
        logs: Array<{ topics: string[]; data: string; address: string }>;
      }>(this.rpcUrl, "eth_getTransactionReceipt", [txHash]);
      return receipt;
    } catch (err) {
      console.error(`Failed to get receipt for ${txHash}:`, err);
      return null;
    }
  }

  async getTokenBalance(tokenAddress: string, holder: string, blockNumber: string): Promise<number | null> {
    try {
      // ERC-20 balanceOf(address) signature: 0x70a08231
      const encodedCall = "0x70a08231" + holder.slice(2).padStart(64, "0");
      const result = await rpcCall<string>(this.rpcUrl, "eth_call", [
        { to: tokenAddress, data: encodedCall },
        blockNumber,
      ]);
      // Result is 32-byte hex value - assume 18 decimals
      const balance = BigInt(result).toString();
      return Number(balance) / 1e18;
    } catch (err) {
      console.error(`Failed to get balance for ${tokenAddress} at ${holder}:`, err);
      return null;
    }
  }
}
