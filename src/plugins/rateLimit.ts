import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

/**
 * A single global limit for now. STATUS: stub — the real product promises
 * per-tier limits (see the pricing table in the product spec: Free 50k
 * calls/mo, Builder 1M/mo, Growth 10M/mo...), which needs the request's
 * resolved API key/tier from src/plugins/apiKey.ts, not just its IP.
 */
export default fp(async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
});
