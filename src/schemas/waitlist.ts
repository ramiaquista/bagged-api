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
