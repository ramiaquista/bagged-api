import type { FastifyInstance } from "fastify";
import { deleteWebhook, listWebhooks, registerWebhook } from "../db/webhooks.js";
import { RegisterWebhookSchema } from "../schemas/webhook.js";

/**
 * `webhooks.id` is a Postgres `uuid` column -- querying it with a
 * malformed value throws a DB-level error rather than just matching zero
 * rows. Pre-validating the shape here preserves the old in-memory Map's
 * behavior (any unrecognized id, well-formed or not, is a plain 404)
 * instead of leaking a 500 for a client typo.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Backed by the `webhooks` table (see db/schema.sql) via `app.db`
 * (src/plugins/db.ts) and the data-access helpers in src/db/webhooks.ts --
 * mirrors src/routes/waitlist.ts's DAL pattern.
 *
 * This file is pure bookkeeping (register/list/delete), same as before.
 * Actual delivery -- diffing a wallet's PnL against its last known
 * `pnl_snapshots` row and POSTing to `url` when `threshold_pct` is crossed,
 * with retries -- lives in src/worker/webhookWorker.ts (NEXT_STEPS.md
 * Item 6), a background worker started alongside the server in
 * src/index.ts, not in this request path.
 */
export default async function webhookRoutes(app: FastifyInstance) {
  app.post("/webhooks", async (req, reply) => {
    const body = RegisterWebhookSchema.parse(req.body);
    const record = await registerWebhook(app.db, body);
    reply.code(201);
    return record;
  });

  app.get("/webhooks", async () => ({ webhooks: await listWebhooks(app.db) }));

  app.delete("/webhooks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existed = UUID_RE.test(id) && (await deleteWebhook(app.db, id));
    reply.code(existed ? 204 : 404);
  });
}
