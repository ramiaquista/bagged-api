import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { ApiError } from "./lib/errors.js";
import apiKeyPlugin from "./plugins/apiKey.js";
import rateLimitPlugin from "./plugins/rateLimit.js";
import healthRoutes from "./routes/health.js";
import leaderboardRoutes from "./routes/leaderboard.js";
import portfolioRoutes from "./routes/portfolio.js";
import streamRoutes from "./routes/stream.js";
import walletRoutes from "./routes/wallet.js";
import waitlistRoutes from "./routes/waitlist.js";
import walletsRoutes from "./routes/wallets.js";
import webhookRoutes from "./routes/webhooks.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  // Registered before any routes: Fastify snapshots the active error
  // handler onto each route's context at registration time, so a route
  // registered before setErrorHandler() would otherwise keep the
  // built-in default handler instead of this one.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "Invalid request", details: err.flatten() });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  await app.register(cors, { origin: true });
  await app.register(websocket);
  await app.register(rateLimitPlugin);
  await app.register(apiKeyPlugin);

  await app.register(healthRoutes);
  await app.register(walletRoutes);
  await app.register(walletsRoutes);
  await app.register(portfolioRoutes);
  await app.register(leaderboardRoutes);
  await app.register(webhookRoutes);
  await app.register(streamRoutes);
  await app.register(waitlistRoutes);

  return app;
}
