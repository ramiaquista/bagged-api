import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { recordRequestLog } from "../db/requestLog.js";

/**
 * Records one row per request to `api_request_log` (db/schema.sql) for
 * every request that resolves to a real, non-legacy `api_keys` row --
 * backs the "Logs" page of bagged-website's `/b2b-dashboard`
 * (`GET /partner/logs`, src/routes/partner.ts).
 *
 * Deliberately its own plugin, not folded into src/plugins/apiKey.ts:
 * that plugin's `onRequest` hook runs before the route handler, so it
 * can't know the eventual `statusCode` -- this needs `onResponse`, which
 * runs after the response has already been sent. Registered after
 * apiKeyPlugin in src/app.ts so `req.apiKey` is guaranteed set (or the
 * request already ended in a 401 from that plugin, in which case
 * `req.apiKey` stays undefined and this no-ops below).
 *
 * Best-effort, matching recordApiKeyUsage's convention in
 * src/db/apiKeys.ts: a logging failure must never surface to the caller,
 * whose response has already gone out by the time this hook runs.
 */
export default fp(async function requestLogPlugin(app: FastifyInstance) {
  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const apiKeyId = req.apiKey?.id;
    if (!apiKeyId) return; // legacy/internal or unauthenticated -- nothing to attribute this to.

    try {
      await recordRequestLog(app.db, apiKeyId, req.method, req.url.split("?")[0] ?? req.url, reply.statusCode);
    } catch (err) {
      req.log.warn({ err }, "failed to record request log");
    }
  });
});
