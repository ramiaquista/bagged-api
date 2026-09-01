import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";

/**
 * Stand-in auth: any request with an `x-api-key` header matching the
 * configured secret (or the literal "dev" for local convenience) is
 * accepted. `/health` is exempt, and so is `POST /waitlist` — that one is
 * submitted directly from the public marketing site's browser, so it
 * can't require the same secret that gates paid API access. Everything
 * else under `/waitlist` (e.g. `GET /waitlist/count`) stays authenticated.
 *
 * STATUS: stub. Real implementation needs per-key records (owner, tier,
 * usage counters) in Postgres — see db/schema.sql `api_keys` — and the
 * usage-based rate limiting the pricing tiers promise.
 */
export default fp(async function apiKeyPlugin(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    void reply;
    if (req.url.startsWith("/health")) return;
    if (req.method === "POST" && req.url.split("?")[0] === "/waitlist") return;

    const key = req.headers["x-api-key"];
    if (!key || Array.isArray(key)) {
      throw ApiError.unauthorized();
    }
    if (key !== config.API_KEY_SECRET && key !== "dev") {
      throw ApiError.unauthorized();
    }
  });
});
