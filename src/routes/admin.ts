import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "../db/apiKeys.js";
import { countWaitlistEntries, listWaitlistEntries } from "../db/waitlist.js";
import { listWebhooks } from "../db/webhooks.js";
import { ApiError } from "../lib/errors.js";
import { CreateApiKeySchema } from "../schemas/admin.js";

/** Same shape check webhooks.ts uses for `:id` params -- see its comment. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseKeyIdParam(req: FastifyRequest): string {
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) {
    throw ApiError.notFound("No API key found with that id");
  }
  return id;
}

/**
 * Internal-only admin surface backing bagged-website's `/admin` dashboard.
 * NOT part of the public product API surface documented at `/docs` --
 * every route here is gated on the legacy shared-secret/dev-key auth path
 * (`req.apiKey.legacy`, set by src/plugins/apiKey.ts), never on a real
 * per-customer key regardless of tier.
 *
 * That's a deliberate, narrower gate than the pre-existing `GET /waitlist`
 * and `GET /waitlist/count` (which only check for *some* valid x-api-key --
 * see waitlist.ts). This file wraps genuinely sensitive operator actions
 * (minting/rotating/revoking *any* customer's key, reading every
 * customer's webhook config) that must never be reachable with a real
 * customer's own key, however high its tier -- a Growth customer's key
 * must not be able to list or rotate *other* customers' keys. Mirrors
 * scripts/manage-api-key.ts's create/rotate/revoke/list operations (this
 * is the dashboard replacing that CLI, not a new capability) plus
 * read-only views of webhooks/waitlist for the same operator.
 */
// Deliberately `async` even though the body is synchronous: Fastify's hook
// runner decides how to wait on a hook by its function shape -- an
// `async` function (or one returning a Promise) is awaited directly,
// while a plain non-async function is assumed to be callback-style and
// expected to invoke a third `done` argument. This hook takes no `done`
// param, so declaring it as a plain function leaves Fastify waiting
// forever for a callback that never comes (every /admin/* request would
// hang with no response and no error) -- `async` is what makes a bare
// `return`/`throw` resolve/reject the hook immediately instead.
async function requireInternal(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.apiKey?.legacy) {
    throw ApiError.forbidden("This endpoint is internal-only");
  }
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireInternal);

  app.get("/admin/overview", async () => {
    const [apiKeys, waitlistCount, webhooks, waitlistEntries] = await Promise.all([
      listApiKeys(app.db),
      countWaitlistEntries(app.db),
      listWebhooks(app.db),
      listWaitlistEntries(app.db),
    ]);
    const activeApiKeys = apiKeys.filter((k) => !k.revokedAt);
    return {
      apiKeys: { total: apiKeys.length, active: activeApiKeys.length },
      waitlist: { total: waitlistCount, recent: waitlistEntries.slice(-5).reverse() },
      webhooks: { total: webhooks.length },
    };
  });

  app.get("/admin/api-keys", async (req) => {
    const { email } = req.query as { email?: string };
    return { apiKeys: await listApiKeys(app.db, email || undefined) };
  });

  app.post("/admin/api-keys", async (req, reply) => {
    const body = CreateApiKeySchema.parse(req.body);
    const { record, plaintext } = await createApiKey(app.db, body.email, body.tier);
    reply.code(201);
    // plaintext is returned exactly once, same guarantee as
    // scripts/manage-api-key.ts's `create` command -- never persisted,
    // never retrievable again after this response.
    return { apiKey: record, plaintext };
  });

  app.post("/admin/api-keys/:id/rotate", async (req) => {
    const id = parseKeyIdParam(req);
    try {
      const { record, plaintext } = await rotateApiKey(app.db, id);
      return { apiKey: record, plaintext };
    } catch {
      throw ApiError.notFound("No API key found with that id");
    }
  });

  app.post("/admin/api-keys/:id/revoke", async (req) => {
    const id = parseKeyIdParam(req);
    const revoked = await revokeApiKey(app.db, id);
    if (!revoked) {
      throw ApiError.notFound("No API key found with that id (or already revoked)");
    }
    return { revoked: true };
  });

  app.get("/admin/webhooks", async () => ({ webhooks: await listWebhooks(app.db) }));

  app.get("/admin/waitlist", async () => ({ entries: await listWaitlistEntries(app.db) }));
}
