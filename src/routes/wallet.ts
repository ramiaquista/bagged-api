import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getProvider } from "../providers/registry.js";
import { ChainSchema } from "../schemas/chain.js";

const ParamsSchema = z.object({ address: z.string().min(1) });
const QuerySchema = z.object({ chain: ChainSchema });

export default async function walletRoutes(app: FastifyInstance) {
  app.get("/wallet/:address/pnl", async (req) => {
    const { address } = ParamsSchema.parse(req.params);
    const { chain } = QuerySchema.parse(req.query);
    return getProvider(chain).getWalletPnl(address);
  });

  app.get("/wallet/:address/positions", async (req) => {
    const { address } = ParamsSchema.parse(req.params);
    const { chain } = QuerySchema.parse(req.query);
    const positions = await getProvider(chain).getWalletPositions(address);
    return { wallet: address, chain, positions };
  });
}
