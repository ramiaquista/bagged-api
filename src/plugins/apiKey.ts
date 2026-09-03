import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config.js";
import { findActiveApiKeyByHash, hashApiKey, recordApiKeyUsage } from "../db/apiKeys.js";
import { ApiError } from "../lib/errors.js";
import { INTERNAL_TIER, type AccessTier } from "../lib/tiers.js";

export interface ApiKeyContext {
  /** `null` for the legacy shared-secret/dev-key paths -- no api_keys row backs them. */
  id: string | null;
  tier: AccessTier;
  ownerEmail: string | null;
  /** True for the shared-secret/dev-key paths kept for backward compatibility (see below). */
  legacy: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by this plugin's onRequest hook for every authenticated request. */
    apiKey?: ApiKeyContext;
  }
}

/**
 * Real per-customer API keys, backed by the `api_keys` table (db/schema.sql,
 * data access in src/db/apiKeys.ts) -- replacing the single shared-secret
 * stub. `/health` is exempt, and so is `POST /waitlist` -- that one is
 * submitted directly from the public marketing site's browser, so it can't
 * require a secret. Everything else under `/waitlist` (e.g. `GET
 * /waitlist/count`) stays authenticated. `/admin` (all of it) is also
 * exempt -- it has its own real session-cookie login now (src/routes/admin.ts,
 * src/lib/adminAuth.ts), not gated by this plugin at all. Same for
 * `/partner` (all of it) -- bagged-website's self-serve `/b2b-dashboard`,
 * gated by its own session-cookie login instead (src/routes/partner.ts,
 * src/lib/partnerAuth.ts). Neither dashboard's session cookie is an
 * `x-api-key` this plugin would recognize, so both must be exempt here or
 * every dashboard request would 401 before its own auth even runs.
 *
 * BACKWARD COMPATIBILITY (deliberate, not an oversight): the legacy shared
 * `API_KEY_SECRET` -- and the local-only `dev` bypass key, gated behind
 * `ALLOW_DEV_KEY` -- both keep working exactly as before, checked first and
 * without touching Postgres. Rationale:
 *   - Railway/production currently authenticates real traffic with
 *     `API_KEY_SECRET` alone; there's no migration step that swaps every
 *     existing caller onto a per-key credential atomically, and breaking
 *     that on deploy would be a self-inflicted outage.
 *   - The existing Vitest suite (test/auth.test.ts, dev-key-gate.test.ts,
 *     and most route tests) authenticates with the `dev` key -- keeping it
 *     alive means this item doesn't have to rewrite every unrelated test
 *     just to add real per-key auth alongside it.
 * Both legacy paths resolve to the `INTERNAL_TIER` pseudo-tier (see
 * src/lib/tiers.ts) rather than a real stored tier, and skip usage-counter
 * writes entirely (there's no `api_keys.id` to attribute usage to). A real
 * migration off the shared secret (rotating Railway's callers onto issued
 * keys, then deleting this branch) is a follow-up, not part of this item.
 */
export default fp(async function apiKeyPlugin(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    void reply;
    if (req.url.startsWith("/health")) return;
    if (req.method === "POST" && req.url.split("?")[0] === "/waitlist") return;
    // Public shareable PnL-card tool (NEXT_STEPS.md Item 4) -- see
    // src/routes/card.ts. Deliberately public/unauthenticated, unlike
    // GET /wallet/:address/pnl, which stays behind x-api-key. Rate-limited
    // much more strictly than authenticated routes (src/routes/card.ts's
    // CARD_RATE_LIMIT) to bound the abuse risk of having no key at all.
    if (req.method === "GET" && (req.url.split("?")[0] ?? "").startsWith("/card/")) return;
    // Admin dashboard (bagged-website's /admin) has its own real
    // username+password session-cookie auth now -- see
    // src/routes/admin.ts's requireAdminSession and src/lib/adminAuth.ts.
    // The legacy shared secret / dev key deliberately no longer grants
    // admin access; previously it did, via req.apiKey.legacy, which was
    // this route's entire gate.
    if (req.url.startsWith("/admin")) return;
    // Partner dashboard (bagged-website's /b2b-dashboard) -- see
    // src/routes/partner.ts's requirePartnerSession and
    // src/lib/partnerAuth.ts. Same reasoning as the /admin exemption above.
    if (req.url.startsWith("/partner")) return;

    const key = req.headers["x-api-key"];
    if (!key || Array.isArray(key)) {
      throw ApiError.unauthorized();
    }

    const isLegacySecret = key === config.API_KEY_SECRET;
    const isDevKey = config.ALLOW_DEV_KEY && key === "dev";
    if (isLegacySecret || isDevKey) {
      req.apiKey = { id: null, tier: INTERNAL_TIER, ownerEmail: null, legacy: true };
      return;
    }

    const record = await findActiveApiKeyByHash(app.db, hashApiKey(key));
    if (!record) {
      throw ApiError.unauthorized();
    }

    req.apiKey = { id: record.id, tier: record.tier, ownerEmail: record.ownerEmail, legacy: false };

    // Feeds NEXT_STEPS.md Item 7's future per-tier rate limiter -- purely
    // bookkeeping, no limit is enforced here. Best-effort: a write failure
    // here shouldn't fail an otherwise-authenticated request.
    try {
      await recordApiKeyUsage(app.db, record.id);
    } catch (err) {
      req.log.warn({ err }, "failed to record api key usage");
    }
  });
});
