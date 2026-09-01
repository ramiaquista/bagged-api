import { z } from "zod";

/**
 * The three self-serve pricing tiers referenced by NEXT_STEPS.md item 5
 * ("Free/Builder/Growth"). This worktree doesn't have the original product
 * spec doc on hand, so the exact tier names are taken directly from
 * NEXT_STEPS.md rather than guessed.
 */
export const TIER_NAMES = ["free", "builder", "growth"] as const;
export const TierSchema = z.enum(TIER_NAMES);
export type Tier = (typeof TIER_NAMES)[number];

/**
 * Every value `api_keys.tier` is allowed to hold (see db/schema.sql's check
 * constraint). `'enterprise'` predates this item -- the column already
 * allowed it before real per-key auth existed -- and covers manually
 * negotiated deals outside the three self-serve tiers above.
 */
export const STORED_TIERS = [...TIER_NAMES, "enterprise"] as const;
export const StoredTierSchema = z.enum(STORED_TIERS);
export type StoredTier = (typeof STORED_TIERS)[number];

export interface TierLimits {
  /** Human label, used by the key-management script's output. */
  label: string;
  /**
   * JUDGMENT CALL: NEXT_STEPS.md says the pricing tiers in "the [original
   * product] spec" (Free/Builder/Growth) drive this, but that spec doc
   * isn't available in this worktree, and NEXT_STEPS.md doesn't restate
   * the exact per-tier numbers. The monthly request allowances below are
   * reasonable placeholders for a free/mid/growth API pricing structure,
   * NOT the real negotiated numbers -- replace with the actual spec
   * values before relying on them for anything customer-facing.
   *
   * What this item is responsible for is the *shape* (a per-tier limit
   * keyed by `tier`, sitting next to the usage counters in
   * db/schema.sql's `api_key_usage`) so NEXT_STEPS.md Item 7's rate
   * limiter has a concrete, extensible place to read limits from --
   * implementing the actual enforcement is explicitly out of scope here.
   */
  monthlyRequestLimit: number;
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { label: "Free", monthlyRequestLimit: 50_000 },
  builder: { label: "Builder", monthlyRequestLimit: 1_000_000 },
  growth: { label: "Growth", monthlyRequestLimit: 10_000_000 },
};

/**
 * NEXT_STEPS.md Item 7 (usage-based rate limiting per tier, see
 * src/plugins/rateLimit.ts) enforces against an *hourly* rate derived from
 * `monthlyRequestLimit` above, not the raw monthly number directly.
 *
 * JUDGMENT CALL, documented per Item 7's instructions rather than silently
 * picked: `monthlyRequestLimit` is already a placeholder (see the comment
 * on `TierLimits`), and a month-long enforcement window doesn't fit
 * `@fastify/rate-limit`'s mechanics well anyway -- its store is in-memory
 * (see src/plugins/rateLimit.ts), so a month-long bucket would silently
 * reset on every deploy/restart, which is worse than not enforcing a limit
 * at all for something customers are paying to rely on. The real
 * cross-restart source of truth for a key's usage stays the Postgres
 * `api_key_usage` counters (src/db/apiKeys.ts's `recordApiKeyUsage`/
 * `getUsageCount`) -- this hourly figure only drives the fast in-memory
 * pre-request check.
 *
 * Converted to hourly rather than dividing all the way down to per-minute:
 * real API usage is bursty, not uniform -- a customer's dashboard might
 * fire a dozen requests in a few seconds, then go quiet for an hour. A
 * per-minute window at the literal monthly average (e.g. Free:
 * 50,000 / 43,200 minutes ≈ 1 request/minute) would make the product
 * unusable well before a customer got anywhere near their real monthly
 * budget. An hourly window still bounds abuse (a runaway loop or leaked
 * key can't blow through the hourly slice of the quota) while giving
 * legitimate bursty clients real headroom.
 *
 * `RATE_LIMIT_HOURS_PER_MONTH = 720` (24 * 30, a 30-day month, the same
 * assumption implicit in calling the underlying number "monthly"). Each
 * tier's hourly cap is `ceil(monthlyRequestLimit / 720)`:
 *   - free:    50,000 / 720 ≈ 70/hour
 *   - builder: 1,000,000 / 720 ≈ 1,389/hour
 *   - growth:  10,000,000 / 720 ≈ 13,889/hour
 *
 * This does NOT enforce the monthly ceiling itself as a hard cutoff --
 * only this hourly slice of it. Rolling up `api_key_usage` into a true
 * monthly total for billing/overage alerts is a reasonable follow-up, not
 * implemented here.
 */
export const RATE_LIMIT_HOURS_PER_MONTH = 720;

/** `ceil(monthlyRequestLimit / RATE_LIMIT_HOURS_PER_MONTH)`, floored at 1/hour. */
export function hourlyRequestLimit(tier: Tier): number {
  return Math.max(1, Math.ceil(TIER_LIMITS[tier].monthlyRequestLimit / RATE_LIMIT_HOURS_PER_MONTH));
}

/**
 * Pseudo-tier assigned to requests authenticated via the legacy shared
 * `API_KEY_SECRET` or the local-only `dev` bypass key (see
 * src/plugins/apiKey.ts) -- neither is backed by an `api_keys` row, so
 * there's no stored tier to report. Deliberately has no entry in
 * TIER_LIMITS (treated as unlimited by convention) so a future rate
 * limiter doesn't accidentally throttle internal/ops/test traffic using a
 * real customer tier's numbers, and doesn't accidentally grant a real
 * customer this same unlimited treatment either.
 */
export const INTERNAL_TIER = "internal" as const;

/** Every tier value `req.apiKey.tier` can hold, stored or pseudo. */
export type AccessTier = StoredTier | typeof INTERNAL_TIER;
