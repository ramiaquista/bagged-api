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
