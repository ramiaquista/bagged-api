import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { buildCorsOriginOption } from "./lib/cors.js";
import { ApiError } from "./lib/errors.js";
import { captureException, initSentry } from "./lib/sentry.js";
import apiKeyPlugin from "./plugins/apiKey.js";
import dbPlugin from "./plugins/db.js";
import rateLimitPlugin from "./plugins/rateLimit.js";
import requestLogPlugin from "./plugins/requestLog.js";
import adminRoutes from "./routes/admin.js";
import cardRoutes from "./routes/card.js";
import healthRoutes from "./routes/health.js";
import leaderboardRoutes from "./routes/leaderboard.js";
import partnerRoutes from "./routes/partner.js";
import portfolioRoutes from "./routes/portfolio.js";
import streamRoutes from "./routes/stream.js";
import walletRoutes from "./routes/wallet.js";
import waitlistRoutes from "./routes/waitlist.js";
import walletsRoutes from "./routes/wallets.js";
import webhookRoutes from "./routes/webhooks.js";

export async function buildApp(): Promise<FastifyInstance> {
  initSentry();

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
    // Well-formed 4xx errors thrown by Fastify itself or its plugins --
    // most notably @fastify/rate-limit, which throws a plain `Error` with
    // `.statusCode = 429` (see rateLimitPlugin/cardRoutes) rather than an
    // ApiError. Without this branch those were falling through to the
    // generic 500 below, silently turning "rate limit exceeded" into
    // "internal error" for callers. Only trusts 4xx here -- a plugin/core
    // error tagged with a 5xx statusCode still goes through captureException.
    if (err instanceof Error && "statusCode" in err) {
      const statusCode = (err as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
        return reply.code(statusCode).send({ error: "request_error", message: err.message });
      }
    }
    captureException(err);
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  // credentials: true -- required for the browser to accept the admin
  // dashboard's session cookie on cross-site requests (bagged-website's
  // bagged.life vs bagged-api's separate Railway domain). Safe alongside
  // an allowlist-based `origin` function like buildCorsOriginOption:
  // @fastify/cors reflects back the one matched origin (never `*`) when
  // credentials are enabled, which is what the spec requires.
  await app.register(cors, { origin: buildCorsOriginOption(config), credentials: true });
  await app.register(cookie);
  await app.register(websocket);
  await app.register(dbPlugin);
  // apiKey before rateLimit: rateLimit's tier-aware max/timeWindow (see
  // src/plugins/rateLimit.ts) reads req.apiKey, which apiKey.ts's onRequest
  // hook sets. Both plugins use fastify-plugin (fp()), so they attach
  // top-level hooks in registration order -- this order alone would be
  // enough, but rateLimit.ts also pins itself to the `preHandler` hook
  // stage (always after `onRequest`) as a second, order-independent
  // guarantee of the same thing.
  await app.register(apiKeyPlugin);
  await app.register(rateLimitPlugin);
  // After apiKeyPlugin: needs req.apiKey (set onRequest) to know which key
  // to attribute a response to -- see that plugin's own comment.
  await app.register(requestLogPlugin);

  await app.register(healthRoutes);
  await app.register(cardRoutes);
  await app.register(walletRoutes);
  await app.register(walletsRoutes);
  await app.register(portfolioRoutes);
  await app.register(leaderboardRoutes);
  await app.register(webhookRoutes);
  await app.register(streamRoutes);
  await app.register(waitlistRoutes);
  await app.register(adminRoutes);
  await app.register(partnerRoutes);

  return app;
}
