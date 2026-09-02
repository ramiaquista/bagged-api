import type { FastifyInstance } from "fastify";
import { createApiKey } from "../db/apiKeys.js";
import { countWaitlistEntries, insertWaitlistSignup, listWaitlistEntries } from "../db/waitlist.js";
import { ApiError } from "../lib/errors.js";
import { tryReserveWaitlistKeySlot, WAITLIST_KEYS_PER_IP_PER_DAY } from "../lib/waitlistAbuseGuard.js";
import { WaitlistSignupSchema, type WaitlistSignupResponse } from "../schemas/waitlist.js";

/**
 * Rate limit for `POST /waitlist`. Exported (same pattern as
 * `CARD_RATE_LIMIT` in src/routes/card.ts) so tests can assert against the
 * exact configured value instead of a magic number.
 *
 * ABUSE-SURFACE DECISION: this was `{ max: 10, timeWindow: "1 minute" }`
 * before this endpoint minted real API keys -- sized for "protect a mailing
 * list from spam." Now that a genuinely-new signup mints a real, usable
 * credential, tightened to 5/min per IP. That alone still isn't a hard
 * ceiling on total keys minted (5/min sustained all day is still 7,200
 * potential keys), so it's paired with a coarser secondary guard --
 * `tryReserveWaitlistKeySlot` below -- that caps keys actually *issued* per
 * IP per day, independent of how the per-minute limit is paced around. See
 * src/lib/waitlistAbuseGuard.ts for the full reasoning on that second
 * check and its tradeoffs.
 */
export const WAITLIST_RATE_LIMIT = {
  max: 5,
  timeWindow: "1 minute",
} as const;

/**
 * Backed by the `waitlist` table (see db/schema.sql) via `app.db`
 * (src/plugins/db.ts) and the data-access helpers in src/db/waitlist.ts.
 *
 * Deliberately exempt from the x-api-key check (see plugins/apiKey.ts):
 * this is the public marketing site's signup form, submitted directly
 * from the visitor's browser, so it can't require the same secret that
 * gates paid API access.
 */
export default async function waitlistRoutes(app: FastifyInstance) {
  app.post(
    "/waitlist",
    // Public + unauthenticated, so give it a tighter limit than the
    // global default (100/min) to blunt basic spam/abuse. See
    // WAITLIST_RATE_LIMIT's comment above for why this is stricter than
    // it used to be.
    { config: { rateLimit: WAITLIST_RATE_LIMIT } },
    async (req, reply) => {
      const body = WaitlistSignupSchema.parse(req.body);

      // Wraps the waitlist insert and (for a genuinely-new signup) the key
      // creation in one transaction -- mirrors the begin/commit/rollback
      // pattern rotateApiKey already uses in src/db/apiKeys.ts. Without
      // this, a crash/error between the two steps could leave someone on
      // the waitlist with no key and no error surfaced; the whole point of
      // this feature is that signup => key is one atomic promise.
      const client = await app.db.connect();
      try {
        await client.query("begin");

        const { inserted } = await insertWaitlistSignup(client, body);
        if (!inserted) {
          // Nothing to roll back -- the insert was a no-op (on conflict do
          // nothing). Commit is a formality here, but keeps one consistent
          // begin/commit/rollback shape for the whole handler rather than
          // special-casing an early return around the transaction.
          await client.query("commit");
          reply.code(200);
          return { status: "already_registered" };
        }

        // Only a genuinely-new signup reaches here (see the `inserted`
        // check above) -- a resubmit of an already-registered email never
        // consumes this IP's daily key-issuance budget.
        if (!tryReserveWaitlistKeySlot(req.ip)) {
          throw ApiError.rateLimited(
            `This IP has already been issued ${WAITLIST_KEYS_PER_IP_PER_DAY} new API keys today. Try again tomorrow.`,
          );
        }

        // Tier is always "free" here -- see NEXT_STEPS.md's Part 1 design
        // decision 4: Builder/Growth have no payment collection behind
        // them yet, so offering a tier choice on this form would create
        // the same dead-end this feature exists to fix.
        const { plaintext } = await createApiKey(client, body.email, "free");

        await client.query("commit");
        reply.code(201);
        const response: WaitlistSignupResponse = { status: "ok", api_key: plaintext };
        return response;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // Not part of the public product spec's API surface -- an internal
  // convenience for checking signups before there's a real dashboard.
  // Keep it behind the standard x-api-key check (not registered above).
  app.get("/waitlist/count", async () => ({ count: await countWaitlistEntries(app.db) }));

  // Same auth as /waitlist/count: protected, internal-only for now. Returns
  // the actual signups (not just a count) so there's a way to see *who*
  // signed up ahead of a real dashboard.
  app.get("/waitlist", async () => ({ entries: await listWaitlistEntries(app.db) }));
}
