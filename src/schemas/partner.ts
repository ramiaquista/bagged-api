import { z } from "zod";

/**
 * Body for `POST /partner/signup` (src/routes/partner.ts) -- self-serve
 * account creation for bagged-website's `/b2b-dashboard`, unlike the
 * internal `/admin` dashboard (one hardcoded operator, no signup at all).
 *
 * `password` minimum length is a basic strength floor, not a full policy
 * (no complexity rules) -- this is a v1 self-serve flow, not meant to
 * relitigate password-policy design; 8 characters matches what most
 * developer-facing API platforms require at minimum.
 */
export const PartnerSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  companyName: z.string().trim().min(1).max(200).optional(),
});
export type PartnerSignupRequest = z.infer<typeof PartnerSignupSchema>;

/** Body for `POST /partner/login` (src/routes/partner.ts). */
export const PartnerLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type PartnerLoginRequest = z.infer<typeof PartnerLoginSchema>;
