import type { FastifyInstance } from "fastify";
import { WaitlistSignupSchema, type WaitlistEntry } from "../schemas/waitlist.js";

/**
 * In-memory store — resets on every restart, and this process itself
 * won't survive a redeploy, so nothing here is durable yet.
 *
 * STATUS: stub. Real implementation needs a `waitlist` table (or reuse of
 * `api_keys`/a CRM) so signups survive restarts and can be exported —
 * see db/schema.sql and the README "Persistence" note.
 *
 * Deliberately exempt from the x-api-key check (see plugins/apiKey.ts):
 * this is the public marketing site's signup form, submitted directly
 * from the visitor's browser, so it can't require the same secret that
 * gates paid API access.
 */
const entries = new Map<string, WaitlistEntry>();

export default async function waitlistRoutes(app: FastifyInstance) {
  app.post(
    "/waitlist",
    // Public + unauthenticated, so give it a tighter limit than the
    // global default (100/min) to blunt basic spam/abuse.
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = WaitlistSignupSchema.parse(req.body);

      if (entries.has(body.email)) {
        reply.code(200);
        return { status: "already_registered" };
      }

      entries.set(body.email, { ...body, created_at: new Date().toISOString() });
      reply.code(201);
      return { status: "ok" };
    },
  );

  // Not part of the public product spec's API surface — an internal
  // convenience for checking signups before there's a real dashboard.
  // Keep it behind the standard x-api-key check (not registered above).
  app.get("/waitlist/count", async () => ({ count: entries.size }));
}
