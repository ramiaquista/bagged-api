import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getProvider } from "../providers/registry.js";
import { ChainSchema } from "../schemas/chain.js";

const ParamsSchema = z.object({ address: z.string().min(1) });
const QuerySchema = z.object({ chain: ChainSchema });

/**
 * Pushes a fresh PnL read every few seconds over the WS connection.
 *
 * STATUS: stub — polls the mock provider on an interval rather than
 * subscribing to real fills. Real implementation should push on actual
 * on-chain events (Helius/Alchemy webhooks -> recompute -> push), not a
 * timer.
 */
export default async function streamRoutes(app: FastifyInstance) {
  app.get("/wallet/:address/stream", { websocket: true }, (socket, req) => {
    const paramsResult = ParamsSchema.safeParse(req.params);
    const queryResult = QuerySchema.safeParse(req.query);

    if (!paramsResult.success || !queryResult.success) {
      socket.close(1008, "invalid address or chain");
      return;
    }

    const { address } = paramsResult.data;
    const { chain } = queryResult.data;
    const provider = getProvider(chain);

    const tick = async () => {
      const pnl = await provider.getWalletPnl(address);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(pnl));
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), 5000);

    socket.on("close", () => clearInterval(interval));
  });
}
