import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ApiError } from "../lib/errors.js";
import { hourlyRequestLimit, TIER_LIMITS, TIER_NAMES, type Tier } from "../lib/tiers.js";
import type { ApiKeyContext } from "./apiKey.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Baseline limit for everything that ISN'T a real, tiered per-customer key:
 *   - the legacy shared-secret / dev-key path (`internal` pseudo-tier)
 *   - `enterprise` keys, which deliberately have no fixed number in
 *     TIER_LIMITS (see the comment on `TierLimits` in src/lib/tiers.ts --
 *     negotiated individually, not a self-serve tier)
 *   - unauthenticated routes (`/health`, `POST /waitlist`)
 *
 * This is exactly the single global limit the whole API had before this
 * item (100 req/min, keyed by IP) -- kept byte-for-byte so existing Railway
 * traffic on the shared secret isn't newly rate-limited more strictly than
 * it already is today (NEXT_STEPS.md Item 7's explicit requirement).
 */
const DEFAULT_MAX = 100;
const DEFAULT_WINDOW_MS = MINUTE_MS;

type TieredKeyContext = ApiKeyContext & { id: string; tier: Tier; legacy: false };

function isTierName(tier: string): tier is Tier {
  return (TIER_NAMES as readonly string[]).includes(tier);
}

/**
 * True only for a resolved, real, non-revoked per-customer key on one of
 * the three self-serve tiers (free/builder/growth) -- i.e. exactly the
 * cases `TIER_LIMITS` has a number for. Everything else (legacy/internal,
 * enterprise, or no key at all) falls back to `DEFAULT_MAX`/`DEFAULT_WINDOW_MS`
 * above.
 */
function isTieredKey(apiKey: FastifyRequest["apiKey"]): apiKey is TieredKeyContext {
  return !!apiKey && !apiKey.legacy && apiKey.id !== null && isTierName(apiKey.tier);
}

/**
 * Real per-customer keys are rate-limited per key, not per IP, so one
 * customer calling from many IPs (mobile clients, serverless functions,
 * etc.) shares one bucket, and many different customers behind the same
 * NAT/corporate proxy don't share one. Everything else (legacy/internal,
 * or no key at all -- e.g. `/health`) falls back to the plugin's original
 * per-IP behavior.
 */
function rateLimitKey(req: FastifyRequest): string {
  if (req.apiKey?.id) return `apikey:${req.apiKey.id}`;
  return `ip:${req.ip}`;
}

/**
 * Usage-based rate limiting per tier (NEXT_STEPS.md Item 7).
 *
 * ENFORCEMENT MECHANISM, and why it's split from the Item-5 usage counters:
 * this plugin enforces limits via `@fastify/rate-limit`'s own in-memory LRU
 * store (the library's default `LocalStore`), keyed per API key (or per IP
 * for the legacy/unauthenticated paths -- see `rateLimitKey`). That's a
 * deliberate choice, not a second parallel usage-tracking system competing
 * with `src/db/apiKeys.ts`:
 *   - `recordApiKeyUsage`/`getUsageCount`/`usageWindowStart` (written by
 *     src/plugins/apiKey.ts on every authenticated request) remain the
 *     durable, cross-restart source of truth for how much a key has
 *     actually used -- billing, support tooling, and `manage-api-key.ts`
 *     all read from Postgres, not from this plugin.
 *   - This plugin's job is the fast, synchronous, pre-request check: "is
 *     this request over the limit *right now*." An in-memory store is the
 *     right tool for that -- no extra DB round trip on the hot path beyond
 *     the one `apiKey.ts` already does, and it's the mechanism
 *     `@fastify/rate-limit` is actually built around (see its README's
 *     `store` section for the alternative -- a fully custom Postgres-backed
 *     store -- which would add a second read+write per request for a
 *     single-instance deployment that doesn't need it yet).
 *   - The one real tradeoff: this in-memory counter resets on redeploy/
 *     restart, and doesn't sync across multiple API instances. Acceptable
 *     for the current single-instance Railway deployment; if this API is
 *     ever horizontally scaled, swap in `@fastify/rate-limit`'s built-in
 *     Redis store (see its README) -- the `max`/`timeWindow`/`keyGenerator`
 *     logic below doesn't change either way.
 *
 * ORDERING: registered with `hook: "preHandler"` so it always runs after
 * src/plugins/apiKey.ts's `onRequest` hook, regardless of plugin
 * registration order -- `req.apiKey` is guaranteed to be populated (or the
 * request has already been rejected with 401) before any limit is checked.
 * This is also what keeps a revoked/invalid key a 401, never a 429: the
 * apiKey plugin throws before this hook ever runs.
 *
 * See src/lib/tiers.ts's `hourlyRequestLimit` for how each tier's
 * placeholder `monthlyRequestLimit` maps to the hourly number enforced
 * here, and why.
 */
export default fp(async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    hook: "preHandler",
    keyGenerator: rateLimitKey,
    max: (req) => (isTieredKey(req.apiKey) ? hourlyRequestLimit(req.apiKey.tier) : DEFAULT_MAX),
    timeWindow: (req) => (isTieredKey(req.apiKey) ? HOUR_MS : DEFAULT_WINDOW_MS),
    errorResponseBuilder(req, context) {
      const apiKey = req.apiKey;
      const scope = isTieredKey(apiKey) ? `the ${TIER_LIMITS[apiKey.tier].label} tier` : "this client";
      const windowLabel = isTieredKey(apiKey) ? "hour" : "minute";
      return ApiError.rateLimited(
        `Rate limit exceeded for ${scope}: ${context.max} requests per ${windowLabel}. ` +
          `Retry after ${Math.ceil(context.ttl / 1000)}s.`,
      );
    },
  });
});
