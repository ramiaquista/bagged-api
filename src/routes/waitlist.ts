import type { FastifyInstance } from "fastify";
import { countWaitlistEntries, insertWaitlistSignup, listWaitlistEntries } from "../db/waitlist.js";
import { WaitlistSignupSchema } from "../schemas/waitlist.js";

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
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = WaitlistSignupSchema.parse(req.body);

      const { inserted } = await insertWaitlistSignup(app.db, body);
      if (!inserted) {
        reply.code(200);
        return { status: "already_registered" };
      }

      reply.code(201);
      return { status: "ok" };
    },
  );

  // Not part of the public product spec's API surface — an internal
  // convenience for checking signups before there's a real dashboard.
  // Keep it behind the standard x-api-key check (not registered above).
  app.get("/waitlist/count", async () => ({ count: await countWaitlistEntries(app.db) }));

  // Same auth as /waitlist/count: protected, internal-only for now. Returns
  // the actual signups (not just a count) so there's a way to see *who*
  // signed up ahead of a real dashboard.
  app.get("/waitlist", async () => ({ entries: await listWaitlistEntries(app.db) }));
}
