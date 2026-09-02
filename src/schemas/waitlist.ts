import { z } from "zod";

export const WaitlistSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  /** Optional free-text: what they're building / why they want access. */
  note: z.string().trim().max(500).optional(),
});
export type WaitlistSignupRequest = z.infer<typeof WaitlistSignupSchema>;

export const WaitlistEntrySchema = WaitlistSignupSchema.extend({
  created_at: z.string().datetime(),
});
export type WaitlistEntry = z.infer<typeof WaitlistEntrySchema>;

/**
 * Response shape for a genuinely-new signup (the `201` path in
 * src/routes/waitlist.ts). `api_key` is the plaintext key, shown here and
 * only here -- see the "shown once" warning on `createApiKey` in
 * src/db/apiKeys.ts. Not used to *validate* the outgoing response (nothing
 * else in this file's response shapes is, either -- see `WaitlistEntry`
 * above), just to give the route a shared, named type instead of an inline
 * object literal.
 *
 * The `already_registered` (`200`) response intentionally has no schema
 * here: it's a fixed `{ status: "already_registered" }` with no `api_key`
 * field ever, so there's nothing to type beyond that literal.
 */
export const WaitlistSignupResponseSchema = z.object({
  status: z.literal("ok"),
  api_key: z.string(),
});
export type WaitlistSignupResponse = z.infer<typeof WaitlistSignupResponseSchema>;
