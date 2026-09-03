import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "../db/apiKeys.js";
import { countWaitlistEntries, listWaitlistEntries } from "../db/waitlist.js";
import { listWebhooks } from "../db/webhooks.js";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  createAdminSessionToken,
  verifyAdminPassword,
  verifyAdminSessionToken,
} from "../lib/adminAuth.js";
import { ApiError } from "../lib/errors.js";
import { AdminLoginSchema, CreateApiKeySchema } from "../schemas/admin.js";

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
 * Rate limit for `POST /admin/login`. Same pattern as `WAITLIST_RATE_LIMIT`
 * in src/routes/waitlist.ts. This guards a real password now (not the old
 * shared secret every other route also accepted), so it's worth blunting
 * brute-force guessing explicitly rather than relying only on the global
 * default (src/plugins/rateLimit.ts's `DEFAULT_MAX`, 100/min).
 */
export const ADMIN_LOGIN_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const;

/**
 * Internal-only admin surface backing bagged-website's `/admin` dashboard.
 * NOT part of the public product API surface documented at `/docs` --
 * every route here (other than login/logout themselves) requires a valid
 * admin session cookie, set by `POST /admin/login` after verifying the
 * single operator account's username/password (src/lib/adminAuth.ts,
 * ADMIN_USERNAME/ADMIN_PASSWORD_HASH in src/config.ts). No `x-api-key` of
 * any kind -- real customer key or the old shared secret -- grants access
 * here anymore; src/plugins/apiKey.ts exempts `/admin` entirely.
 *
 * This wraps genuinely sensitive operator actions (minting/rotating/
 * revoking *any* customer's key, reading every customer's webhook config)
 * that must never be reachable with a real customer's own key, however
 * high its tier. Mirrors scripts/manage-api-key.ts's
 * create/rotate/revoke/list operations (this is the dashboard replacing
 * that CLI, not a new capability) plus read-only views of
 * webhooks/waitlist for the same operator.
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
async function requireAdminSession(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Login/logout must be reachable without already having a session --
  // that's the whole point of a login endpoint, and logout should clear a
  // cookie even if it's already invalid/expired rather than 401ing.
  const path = req.url.split("?")[0];
  if (path === "/admin/login" || path === "/admin/logout") return;

  const token = req.cookies[ADMIN_SESSION_COOKIE];
  if (!verifyAdminSessionToken(config.ADMIN_SESSION_SECRET, token)) {
    throw ApiError.unauthorized("Not signed in");
  }
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdminSession);

  app.post(
    "/admin/login",
    { config: { rateLimit: ADMIN_LOGIN_RATE_LIMIT } },
    async (req, reply) => {
      const { username, password } = AdminLoginSchema.parse(req.body);

      // Both checks always run (no short-circuit on username) and the
      // same message covers either failure -- don't let response timing
      // or wording reveal whether the username alone was right.
      const validUsername = username === config.ADMIN_USERNAME;
      const validPassword = verifyAdminPassword(password, config.ADMIN_PASSWORD_HASH);
      if (!validUsername || !validPassword) {
        throw ApiError.unauthorized("Invalid username or password");
      }

      const token = createAdminSessionToken(config.ADMIN_SESSION_SECRET);
      reply.setCookie(ADMIN_SESSION_COOKIE, token, {
        httpOnly: true,
        secure: true,
        // Cross-site by design: bagged-website (bagged.life) and
        // bagged-api (a separate Railway domain) are different sites, so
        // the cookie must opt in to being sent cross-site at all.
        // SameSite=None requires Secure -- both browsers treat `localhost`
        // as a secure context, so this still works over plain http in
        // local dev.
        sameSite: "none",
        path: "/admin",
        maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
      });
      return { ok: true };
    },
  );

  app.post("/admin/logout", async (_req, reply) => {
    // Attributes must match the cookie set at login for the browser to
    // recognize this as clearing the same cookie, not setting an unrelated
    // one -- deletion keys off name+path (Domain too, if set), but keeping
    // secure/sameSite identical as well avoids relying on that nuance.
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: "/admin", secure: true, sameSite: "none" });
    return { ok: true };
  });

  // Cheap "is my cookie still valid" check for the dashboard's mount-time
  // gate (bagged-website's adminApi.tsx) -- avoids running /admin/overview's
  // real queries just to test auth on every page load.
  app.get("/admin/session", async () => ({ authenticated: true }));

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
