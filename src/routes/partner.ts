import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import {
  countActiveApiKeysForPartner,
  createApiKey,
  findApiKeyById,
  getUsageSince,
  listApiKeysForPartner,
  rotateApiKey,
  revokeApiKey,
} from "../db/apiKeys.js";
import { createPartner, findPartnerByEmailWithHash, findPartnerById, PartnerEmailTakenError } from "../db/partners.js";
import { listRequestLogs } from "../db/requestLog.js";
import { ApiError } from "../lib/errors.js";
import {
  hashPartnerPassword,
  PARTNER_SESSION_COOKIE,
  PARTNER_SESSION_TTL_MS,
  createPartnerSessionToken,
  verifyPartnerPassword,
  verifyPartnerSessionToken,
} from "../lib/partnerAuth.js";
import { hourlyRequestLimit, TIER_LIMITS, TIER_NAMES, type Tier } from "../lib/tiers.js";
import { PartnerLoginSchema, PartnerSignupSchema } from "../schemas/partner.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requirePartnerSession below for every authenticated /partner/* request. */
    partnerId?: string;
  }
}

/** Same shape check webhooks.ts / admin.ts use for `:id` params -- see webhooks.ts's comment. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseKeyIdParam(req: FastifyRequest): string {
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) {
    throw ApiError.notFound("No API key found with that id");
  }
  return id;
}

/**
 * Every self-serve key a partner creates is issued on the `free` tier --
 * there's no self-serve tier picker in this v1 (upgrading a partner to
 * Builder/Growth stays a manual /admin action, same as it is today for
 * hand-issued keys; see the "manage plans" scope note in
 * src/routes/partner.ts's module comment below). `Tier`, not `StoredTier`
 * -- `enterprise` is never self-serve-issuable, matching
 * src/schemas/admin.ts's CreateApiKeySchema comment on the same point.
 */
const SELF_SERVE_TIER: Tier = "free";

/**
 * Cap on how many *active* keys one partner can hold at once via self-serve
 * creation. Not a security boundary (a partner could always ask via
 * support/the shared inbox for more) -- just a sane guardrail against a
 * runaway client or a confused user spamming "create key" so the dashboard
 * doesn't fill up with dozens of live keys nobody's using.
 */
export const PARTNER_MAX_ACTIVE_KEYS = 5;

/**
 * Rate limits for the two unauthenticated /partner endpoints, matching
 * ADMIN_LOGIN_RATE_LIMIT's pattern in src/routes/admin.ts -- these guard
 * real password checks / account creation, so they're blunted well below
 * the global default (src/plugins/rateLimit.ts's DEFAULT_MAX, 100/min).
 */
export const PARTNER_LOGIN_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const;
export const PARTNER_SIGNUP_RATE_LIMIT = { max: 5, timeWindow: "10 minutes" } as const;

/**
 * Self-serve partner (developer/customer) surface backing bagged-website's
 * `/b2b-dashboard` -- where a new partner creates their own account, gets
 * an API key, and can track their usage/limits and recent request logs.
 *
 * This is deliberately a different authentication model from
 * src/routes/admin.ts's internal dashboard: /admin has exactly one
 * operator account (Rami), configured via env vars, with no signup at
 * all. /partner has any number of self-serve accounts, backed by the
 * `partners` table (db/schema.sql), created here via `POST /partner/signup`.
 * Both use the same shape of mechanism underneath (scrypt password hash +
 * signed session cookie, see src/lib/adminAuth.ts vs src/lib/partnerAuth.ts)
 * but are otherwise fully independent -- an admin session cookie doesn't
 * authenticate here and vice versa, and src/plugins/apiKey.ts exempts
 * `/partner` from the x-api-key gate entirely, the same way it already
 * exempts `/admin`.
 *
 * SCOPE NOTE (plan management): this router deliberately has no
 * "change my plan" endpoint. There's no billing/payment integration in
 * this codebase yet, so a self-serve tier switcher would either have to
 * fake it (misleading) or block on Stripe setup (out of scope for this
 * item, per the explicit decision to skip it). Every self-serve key is
 * issued on the `free` tier; moving a partner's key to `builder`/`growth`
 * stays a manual action from the existing /admin dashboard
 * (`POST /admin/api-keys/:id/rotate` issues a new key, but there's
 * currently no admin "change tier in place" endpoint either -- upgrading
 * today means the admin issues a fresh key at the new tier by hand and
 * the partner swaps to it). A real self-serve plan switcher is a
 * reasonable follow-up once billing exists.
 */
async function requirePartnerSession(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // Signup/login must be reachable without already having a session --
  // that's the whole point of those endpoints.
  const path = req.url.split("?")[0];
  if (path === "/partner/signup" || path === "/partner/login") return;

  const token = req.cookies[PARTNER_SESSION_COOKIE];
  const partnerId = verifyPartnerSessionToken(config.PARTNER_SESSION_SECRET, token);
  if (!partnerId) {
    throw ApiError.unauthorized("Not signed in");
  }
  req.partnerId = partnerId;
}

function setPartnerSessionCookie(reply: FastifyReply, secret: string, partnerId: string): void {
  const token = createPartnerSessionToken(secret, partnerId);
  reply.setCookie(PARTNER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    // Cross-site by design, same as ADMIN_SESSION_COOKIE (src/routes/admin.ts):
    // bagged-website and bagged-api are different sites/domains.
    sameSite: "none",
    path: "/partner",
    maxAge: Math.floor(PARTNER_SESSION_TTL_MS / 1000),
  });
}

export default async function partnerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requirePartnerSession);

  app.post("/partner/signup", { config: { rateLimit: PARTNER_SIGNUP_RATE_LIMIT } }, async (req, reply) => {
    const body = PartnerSignupSchema.parse(req.body);

    const passwordHash = hashPartnerPassword(body.password);
    let partner;
    try {
      partner = await createPartner(app.db, body.email, passwordHash, body.companyName ?? null);
    } catch (err) {
      if (err instanceof PartnerEmailTakenError) {
        throw ApiError.badRequest("An account already exists for that email -- try signing in instead.");
      }
      throw err;
    }

    // A brand-new partner needs a key to actually call the API with --
    // issuing one automatically at signup (rather than requiring a
    // separate "now go create a key" step) is what makes this dashboard
    // "onboard, get an API key" in one flow, matching the product's
    // request.
    const { record: apiKey, plaintext } = await createApiKey(app.db, partner.email, SELF_SERVE_TIER, partner.id);

    setPartnerSessionCookie(reply, config.PARTNER_SESSION_SECRET, partner.id);
    reply.code(201);
    return { partner, apiKey, plaintext };
  });

  app.post("/partner/login", { config: { rateLimit: PARTNER_LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const { email, password } = PartnerLoginSchema.parse(req.body);

    const found = await findPartnerByEmailWithHash(app.db, email);
    // Both branches run through the same scrypt verify call shape and the
    // same error message regardless of which failed, same anti-enumeration
    // reasoning as src/routes/admin.ts's login: don't let response timing
    // or wording reveal whether the email alone was registered.
    const validPassword = found ? verifyPartnerPassword(password, found.passwordHash) : false;
    if (!found || !validPassword) {
      throw ApiError.unauthorized("Invalid email or password");
    }

    setPartnerSessionCookie(reply, config.PARTNER_SESSION_SECRET, found.id);
    return { ok: true };
  });

  app.post("/partner/logout", async (_req, reply) => {
    reply.clearCookie(PARTNER_SESSION_COOKIE, { path: "/partner", secure: true, sameSite: "none" });
    return { ok: true };
  });

  // Cheap "is my cookie still valid" check for the dashboard's mount-time
  // gate, same role as GET /admin/session in src/routes/admin.ts.
  app.get("/partner/session", async () => ({ authenticated: true }));

  app.get("/partner/me", async (req) => {
    const partner = await findPartnerById(app.db, req.partnerId!);
    if (!partner) {
      // The session cookie outlived the account it names -- shouldn't
      // normally happen (nothing deletes partners today), but fail closed
      // rather than return a null partner to the dashboard.
      throw ApiError.unauthorized("Not signed in");
    }
    return { partner };
  });

  app.get("/partner/api-keys", async (req) => {
    return { apiKeys: await listApiKeysForPartner(app.db, req.partnerId!) };
  });

  app.post("/partner/api-keys", async (req, reply) => {
    const active = await countActiveApiKeysForPartner(app.db, req.partnerId!);
    if (active >= PARTNER_MAX_ACTIVE_KEYS) {
      throw ApiError.badRequest(
        `You already have ${active} active keys (max ${PARTNER_MAX_ACTIVE_KEYS}). Revoke one before creating another.`,
      );
    }
    const partner = await findPartnerById(app.db, req.partnerId!);
    if (!partner) throw ApiError.unauthorized("Not signed in");

    const { record, plaintext } = await createApiKey(app.db, partner.email, SELF_SERVE_TIER, partner.id);
    reply.code(201);
    return { apiKey: record, plaintext };
  });

  /** Loads a key by id and 404s (never 403 -- avoid confirming another partner's key even exists) unless it belongs to the caller. */
  async function ownedKeyOrNotFound(req: FastifyRequest) {
    const id = parseKeyIdParam(req);
    const record = await findApiKeyById(app.db, id);
    if (!record || record.partnerId !== req.partnerId) {
      throw ApiError.notFound("No API key found with that id");
    }
    return record;
  }

  app.post("/partner/api-keys/:id/rotate", async (req) => {
    const owned = await ownedKeyOrNotFound(req);
    const { record, plaintext } = await rotateApiKey(app.db, owned.id);
    return { apiKey: record, plaintext };
  });

  app.post("/partner/api-keys/:id/revoke", async (req) => {
    const owned = await ownedKeyOrNotFound(req);
    const revoked = await revokeApiKey(app.db, owned.id);
    if (!revoked) {
      throw ApiError.notFound("No API key found with that id (or already revoked)");
    }
    return { revoked: true };
  });

  const HOUR_MS = 60 * 60_000;
  const DAY_MS = 24 * HOUR_MS;

  app.get("/partner/usage", async (req) => {
    const keys = await listApiKeysForPartner(app.db, req.partnerId!);
    const now = new Date();
    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const dayAgo = new Date(now.getTime() - DAY_MS);

    const usage = await Promise.all(
      keys.map(async (key) => {
        const isSelfServeTier = (TIER_NAMES as readonly string[]).includes(key.tier);
        const tier = isSelfServeTier ? (key.tier as Tier) : null;
        const [requestsLastHour, requestsLast24h] = await Promise.all([
          getUsageSince(app.db, key.id, hourAgo),
          getUsageSince(app.db, key.id, dayAgo),
        ]);
        return {
          id: key.id,
          tier: key.tier,
          revoked: key.revokedAt !== null,
          lastUsedAt: key.lastUsedAt,
          hourlyLimit: tier ? hourlyRequestLimit(tier) : null,
          monthlyLimit: tier ? TIER_LIMITS[tier].monthlyRequestLimit : null,
          requestsLastHour,
          requestsLast24h,
        };
      }),
    );

    const activeUsage = usage.filter((u) => !u.revoked);
    return {
      keys: usage,
      totalRequestsLastHour: activeUsage.reduce((sum, u) => sum + u.requestsLastHour, 0),
      totalRequestsLast24h: activeUsage.reduce((sum, u) => sum + u.requestsLast24h, 0),
    };
  });

  app.get("/partner/logs", async (req) => {
    const keys = await listApiKeysForPartner(app.db, req.partnerId!);
    const entries = await listRequestLogs(
      app.db,
      keys.map((k) => k.id),
    );
    return { entries };
  });
}
