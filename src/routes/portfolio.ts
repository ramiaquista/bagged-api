import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CHAINS } from "../schemas/chain.js";
import { getProvider } from "../providers/registry.js";
import { MOCK_WALLETS } from "../providers/mockData.js";

const ParamsSchema = z.object({ userId: z.string().min(1) });

/**
 * Rolls a user's linked wallets, across every chain, into one PnL figure —
 * the actual pitch of the product ("one number, not four dashboards").
 *
 * STATUS: stub. Real implementation needs a `user_wallets` link table
 * (user_id -> [{chain, address}]) — see db/schema.sql — instead of the
 * fixed one-wallet-per-chain mock set used here.
 */
export default async function portfolioRoutes(app: FastifyInstance) {
  app.get("/portfolio/:userId", async (req) => {
    const { userId } = ParamsSchema.parse(req.params);

    const perWallet = await Promise.all(
      CHAINS.map((chain) => getProvider(chain).getWalletPnl(MOCK_WALLETS[chain])),
    );

    const totals = perWallet.reduce(
      (acc, w) => ({
        realized_pnl_usd: acc.realized_pnl_usd + w.realized_pnl_usd,
        unrealized_pnl_usd: acc.unrealized_pnl_usd + w.unrealized_pnl_usd,
        total_pnl_usd: acc.total_pnl_usd + w.total_pnl_usd,
      }),
      { realized_pnl_usd: 0, unrealized_pnl_usd: 0, total_pnl_usd: 0 },
    );

    return {
      user_id: userId,
      wallets: perWallet,
      ...totals,
    };
  });
}
