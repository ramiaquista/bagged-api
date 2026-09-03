import { z } from "zod";
import { TierSchema } from "../lib/tiers.js";

/**
 * Body for `POST /admin/api-keys` (src/routes/admin.ts) -- the internal
 * dashboard's equivalent of `npm run keys:create` (scripts/manage-api-key.ts).
 * Only the three self-serve tiers are issuable here; `enterprise` keys
 * (STORED_TIERS but not TIER_NAMES, see src/lib/tiers.ts) stay a manual
 * negotiated-deal path via the CLI, not a dashboard button.
 */
export const CreateApiKeySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  tier: TierSchema,
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeySchema>;

/**
 * Body for `POST /admin/login` (src/routes/admin.ts) -- the dashboard's
 * real username+password login, replacing the old shared x-api-key gate.
 */
export const AdminLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type AdminLoginRequest = z.infer<typeof AdminLoginSchema>;
