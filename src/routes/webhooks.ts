import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { RegisterWebhookSchema, type WebhookRecord } from "../schemas/webhook.js";

/**
 * In-memory store — resets on every restart.
 *
 * STATUS: stub. Real implementation needs a `webhooks` table (see
 * db/schema.sql) plus a background worker that actually diffs PnL
 * snapshots and delivers (with retries) to `url` when `threshold_pct` is
 * crossed. Nothing is delivered right now — registering a webhook here
 * does not do anything yet besides remember it.
 */
const webhooks = new Map<string, WebhookRecord>();

export default async function webhookRoutes(app: FastifyInstance) {
  app.post("/webhooks", async (req, reply) => {
    const body = RegisterWebhookSchema.parse(req.body);
    const record: WebhookRecord = {
      ...body,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    webhooks.set(record.id, record);
    reply.code(201);
    return record;
  });

  app.get("/webhooks", async () => ({ webhooks: Array.from(webhooks.values()) }));

  app.delete("/webhooks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existed = webhooks.delete(id);
    reply.code(existed ? 204 : 404);
  });
}
