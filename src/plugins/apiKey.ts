import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";

/**
 * Stand-in auth: any request with an `x-api-key` header matching the
 * configured secret (or the literal "dev" for local convenience) is
 * accepted. `/health` is exempt.
 *
 * STATUS: stub. Real implementation needs per-key records (owner, tier,
 * usage counters) in Postgres — see db/schema.sql `api_keys` — and the
 * usage-based rate limiting the pricing tiers promise.
 */
export default fp(async function apiKeyPlugin(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    void reply;
    if (req.url.startsWith("/health")) return;

    const key = req.headers["x-api-key"];
    if (!key || Array.isArray(key)) {
      throw ApiError.unauthorized();
    }
    if (key !== config.API_KEY_SECRET && key !== "dev") {
      throw ApiError.unauthorized();
    }
  });
});
