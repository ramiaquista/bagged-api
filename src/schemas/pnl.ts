import { z } from "zod";
import { ChainSchema } from "./chain.js";

export const WalletPnlSchema = z.object({
  wallet: z.string(),
  chain: ChainSchema,
  realized_pnl_usd: z.number(),
  unrealized_pnl_usd: z.number(),
  total_pnl_usd: z.number(),
  positions_open: z.number().int().nonnegative(),
  wash_trades_excluded: z.number().int().nonnegative(),
  rugs_resolved: z.number().int().nonnegative(),
  as_of: z.string().datetime(),
});
export type WalletPnl = z.infer<typeof WalletPnlSchema>;

export const BatchPnlRequestSchema = z.object({
  wallets: z
    .array(
      z.object({
        address: z.string().min(1),
        chain: ChainSchema,
      }),
    )
    .min(1)
    .max(100),
});
export type BatchPnlRequest = z.infer<typeof BatchPnlRequestSchema>;

export const BatchPnlResponseSchema = z.object({
  results: z.array(WalletPnlSchema),
});
