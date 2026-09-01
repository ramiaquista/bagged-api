import type { FastifyInstance } from "fastify";
import { getProvider } from "../providers/registry.js";
import { BatchPnlRequestSchema } from "../schemas/pnl.js";

export default async function walletsRoutes(app: FastifyInstance) {
  app.post("/wallets/batch", async (req) => {
    const { wallets } = BatchPnlRequestSchema.parse(req.body);
    const results = await Promise.all(
      wallets.map(({ address, chain }) => getProvider(chain).getWalletPnl(address)),
    );
    return { results };
  });
}
