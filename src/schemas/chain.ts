import { z } from "zod";

/**
 * The four chains Bagged covers. BNB Chain, Robinhood Chain, and Ethereum are
 * all EVM-compatible, so they share one provider adapter shape (see
 * src/providers/evm.ts once real integrations land) — Solana is the odd one
 * out and gets its own.
 */
export const ChainSchema = z.enum(["solana", "bnb", "robinhood", "ethereum"]);
export type Chain = z.infer<typeof ChainSchema>;

export const CHAINS: readonly Chain[] = ["solana", "bnb", "robinhood", "ethereum"] as const;
