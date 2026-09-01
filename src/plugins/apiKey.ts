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
 * /waitlist/count`) stays authenticated.
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
