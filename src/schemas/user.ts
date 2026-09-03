import { z } from "zod";
import { ChainSchema } from "./chain.js";

/** Body for `POST /user/signup` (src/routes/user.ts) -- self-serve account creation for bagged-website's `/app`. */
export const UserSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().trim().min(1).max(80).optional(),
});
export type UserSignupRequest = z.infer<typeof UserSignupSchema>;

/** Body for `POST /user/login` (src/routes/user.ts). */
export const UserLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type UserLoginRequest = z.infer<typeof UserLoginSchema>;

/** Body for `POST /user/wallets` (src/routes/user.ts) -- link a wallet into the signed-in user's tracked portfolio. */
export const LinkWalletSchema = z.object({
  chain: ChainSchema,
  address: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(80).optional(),
});
export type LinkWalletRequest = z.infer<typeof LinkWalletSchema>;
