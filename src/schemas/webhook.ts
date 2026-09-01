import { z } from "zod";
import { ChainSchema } from "./chain.js";

export const RegisterWebhookSchema = z.object({
  url: z.string().url(),
  wallet: z.string().min(1),
  chain: ChainSchema,
  /** Fire when |PnL change| crosses this percentage since the last check. */
  threshold_pct: z.number().positive().default(10),
});
export type RegisterWebhookRequest = z.infer<typeof RegisterWebhookSchema>;

export const WebhookRecordSchema = RegisterWebhookSchema.extend({
  id: z.string(),
  created_at: z.string().datetime(),
});
export type WebhookRecord = z.infer<typeof WebhookRecordSchema>;
