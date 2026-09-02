import type { FastifyInstance } from "fastify";
import { countWaitlistEntries, insertWaitlistSignup, listWaitlistEntries } from "../db/waitlist.js";
import { notifyWaitlistSignup } from "../lib/waitlistNotify.js";
import { WaitlistSignupSchema } from "../schemas/waitlist.js";

/**
 * Rate limit for `POST /waitlist`. Exported (same pattern as
 * `CARD_RATE_LIMIT` in src/routes/card.ts) so tests can assert against the
 * exact configured value instead of a magic number.
 *
 * Sized for "protect a mailing list from spam" -- this endpoint only ever
 * records an email address, it does not mint any credential, so there's no
 * higher-stakes abuse surface to size against.
 */
export const WAITLIST_RATE_LIMIT = {
  max: 10,
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
    // global default (100/min) to blunt basic spam/abuse.
    { config: { rateLimit: WAITLIST_RATE_LIMIT } },
    async (req, reply) => {
      const body = WaitlistSignupSchema.parse(req.body);

      const { inserted } = await insertWaitlistSignup(app.db, body);
      if (!inserted) {
        reply.code(200);
        return { status: "already_registered" };
      }

      // Only for a genuinely new signup -- never for a resubmit of an
      // already-registered email. Awaited (not fire-and-forget) so
      // request logs and this route's own error handling cover it, but
      // it can never fail or delay this response beyond a normal HTTP
      // call: notifyWaitlistSignup() catches everything internally and
      // always resolves (see its own doc comment). The waitlist row
      // above has already committed either way.
      await notifyWaitlistSignup(body, req.log);

      reply.code(201);
      return { status: "ok" };
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
