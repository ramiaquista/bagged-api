/**
 * Secondary, coarser abuse guard for `POST /waitlist`, layered on top of the
 * per-route rate limit in src/routes/waitlist.ts (`WAITLIST_RATE_LIMIT`).
 *
 * ABUSE-SURFACE DECISION (NEXT_STEPS.md's "Abuse-surface note", explicitly
 * left open there): this endpoint now mints a real, usable API key on every
 * genuinely-new signup, not just an email row. Two changes address that,
 * not just one:
 *   1. `WAITLIST_RATE_LIMIT` in src/routes/waitlist.ts was tightened from
 *      the original 10 req/min to 5 req/min per IP -- credential issuance
 *      warrants a stricter per-minute ceiling than "protect a mailing list
 *      from spam" did.
 *   2. This module adds a coarser, independent daily cap on keys actually
 *      *issued* per IP (not just requests made). A per-minute-only limit
 *      still lets a slow, patient script mint an unbounded number of keys
 *      over hours -- 5/min sustained for a day is still 7,200 potential
 *      keys. A daily ceiling per IP bounds total key sprawl regardless of
 *      how the per-minute limit is paced around.
 *
 * Only reserves a slot when a key is actually about to be minted (i.e. the
 * caller already confirmed `insertWaitlistSignup` returned
 * `inserted: true`) -- resubmits of an already-registered email hit
 * `already_registered` before this is ever consulted, so they don't burn
 * the IP's daily budget for a request that was never going to issue a key
 * anyway.
 *
 * IMPLEMENTATION TRADEOFF, deliberately mirroring the one
 * src/plugins/rateLimit.ts's own doc comment already makes and justifies
 * for `@fastify/rate-limit`'s in-memory `LocalStore`: this is a fast,
 * synchronous, per-process pre-request check, not a durable, billing-grade
 * source of truth. It resets on redeploy/restart and does not sync across
 * horizontally-scaled instances. That's an acceptable tradeoff for the
 * current single-instance Railway deployment, for the same reason it's
 * acceptable for the per-tier request limiter: a determined attacker who
 * can force redeploys to reset a counter has bigger problems to exploit,
 * and legitimate signups are never bursty enough to notice a per-process
 * counter. If this API is ever horizontally scaled, replace the Map below
 * with a small Postgres-backed counter (same upsert-by-bucket shape as
 * `recordApiKeyUsage`/`api_key_usage` in src/db/apiKeys.ts) rather than
 * inventing a new mechanism.
 */
export const WAITLIST_KEYS_PER_IP_PER_DAY = 20;

interface DailyCount {
  /** UTC calendar day, e.g. "2026-09-02" -- see `utcDay`. */
  day: string;
  count: number;
}

const countsByIp = new Map<string, DailyCount>();

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Attempts to reserve one of `ip`'s remaining key-issuance slots for the
 * current UTC calendar day. Returns `true` and reserves a slot if under
 * `WAITLIST_KEYS_PER_IP_PER_DAY`; returns `false` (reserving nothing) once
 * the cap is hit, so the caller can reject the request instead of minting
 * another key.
 */
export function tryReserveWaitlistKeySlot(ip: string, at: Date = new Date()): boolean {
  const day = utcDay(at);
  const existing = countsByIp.get(ip);

  if (!existing || existing.day !== day) {
    countsByIp.set(ip, { day, count: 1 });
    return true;
  }

  if (existing.count >= WAITLIST_KEYS_PER_IP_PER_DAY) {
    return false;
  }

  existing.count += 1;
  return true;
}

/**
 * Test-only escape hatch: clears all reserved slots so suites that exercise
 * this guard (or that just happen to issue several keys from the same
 * default `app.inject()` IP) don't leak counters across test cases/files.
 */
export function resetWaitlistKeySlotsForTests(): void {
  countsByIp.clear();
}
