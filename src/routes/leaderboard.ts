import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ChainSchema } from "../schemas/chain.js";

const QuerySchema = z.object({
  chain: ChainSchema.optional(),
  window: z.enum(["24h", "7d", "30d"]).default("7d"),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const MOCK_ENTRIES = [
  { wallet: "7xKXtg2CW87d9...f9Q2", chain: "solana", pnl_usd: 114208.42, pnl_pct: 38.6 },
  { wallet: "0x8f3aA61...1e2B", chain: "bnb", pnl_usd: 42910.18, pnl_pct: 21.4 },
  { wallet: "0xC4a17e2...77Fd", chain: "robinhood", pnl_usd: 8340.55, pnl_pct: 64.2 },
  { wallet: "0x1B92aC4...44Ac", chain: "ethereum", pnl_usd: 26775.9, pnl_pct: 12.1 },
] as const;

/**
 * STATUS: stub, returns a fixed mock list regardless of query params.
 * Real implementation needs PnL snapshots persisted per wallet/chain/window
 * (see db/schema.sql `pnl_snapshots`) to rank against.
 */
export default async function leaderboardRoutes(app: FastifyInstance) {
  app.get("/leaderboard", async (req) => {
    const { chain, window, limit } = QuerySchema.parse(req.query);
    const entries = MOCK_ENTRIES.filter((e) => !chain || e.chain === chain)
      .slice(0, limit)
      .map((e, i) => ({ rank: i + 1, ...e }));

    return { chain: chain ?? "all", window, entries };
  });
}
