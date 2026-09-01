import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getProvider } from "../providers/registry.js";
import { ChainSchema } from "../schemas/chain.js";

const ParamsSchema = z.object({ address: z.string().min(1) });
const QuerySchema = z.object({ chain: ChainSchema });

/**
 * Rate limit for the public card route, deliberately stricter than the
 * authenticated default (100 req/min, see src/plugins/rateLimit.ts). This
 * endpoint has no x-api-key gate at all (see the exemption in
 * src/plugins/apiKey.ts), so it's the most abuse-exposed surface in the
 * API -- a much lower per-IP ceiling limits scraping/DoS risk without
 * blocking the actual use case (a visitor loading bagged.life/card/<wallet>
 * a handful of times a minute). Exported so tests can assert against the
 * exact configured value instead of a magic number.
 */
export const CARD_RATE_LIMIT = {
  max: 10,
  timeWindow: "1 minute",
} as const;

/**
 * Public, unauthenticated variant of `GET /wallet/:address/pnl` (see
 * src/routes/wallet.ts), built for bagged-website's shareable PnL-card tool
 * (NEXT_STEPS.md Item 4).
 *
 * DESIGN CHOICE: a separate public route rather than a signed-link scheme.
 * A signed-link scheme (e.g. an HMAC token minted server-side and checked
 * here) would still require *something* to mint the link -- either a
 * public unauthenticated "give me a link" endpoint (same exposure, extra
 * hop) or a build-time/CI step (wrong fit for "paste any wallet" being the
 * whole point of the growth wedge, per NEXT_STEPS.md Item 4). A plain
 * public route matches the existing shape of every other route in this
 * codebase (one Fastify route per concern, auth handled by a single
 * onRequest hook in src/plugins/apiKey.ts) and is trivially strictly
 * rate-limited per-IP using the exact plugin/pattern already in
 * src/plugins/rateLimit.ts, so it doesn't invent a new mechanism.
 *
 * Deliberately a *subset* of `/wallet/:address/pnl`'s response: card
 * rendering only needs the PnL numbers, not positions/streaming, so this
 * doesn't expose any more surface than necessary. It reuses the same
 * `WalletPnl` shape (see src/schemas/pnl.ts) and the same provider registry
 * (src/providers/registry.ts) -- real Solana data via
 * src/providers/solana.ts, real EVM data via src/providers/evm.ts -- so
 * there's exactly one PnL computation path, not a duplicated one for the
 * public surface.
 */
export default async function cardRoutes(app: FastifyInstance) {
  app.get(
    "/card/:address/pnl",
    { config: { rateLimit: CARD_RATE_LIMIT } },
    async (req) => {
      const { address } = ParamsSchema.parse(req.params);
      const { chain } = QuerySchema.parse(req.query);
      return getProvider(chain).getWalletPnl(address);
    },
  );
}
