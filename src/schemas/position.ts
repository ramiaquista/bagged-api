import { z } from "zod";
import { ChainSchema } from "./chain.js";

export const PositionSchema = z.object({
  token: z.string(),
  mint_or_address: z.string(),
  quantity: z.number(),
  value_usd: z.number(),
  cost_basis_usd: z.number(),
  unrealized_pnl_usd: z.number(),
  unrealized_pnl_pct: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

export const WalletPositionsSchema = z.object({
  wallet: z.string(),
  chain: ChainSchema,
  positions: z.array(PositionSchema),
});
