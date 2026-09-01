import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  API_KEY_SECRET: z.string().min(1).default("dev-secret-change-me"),
  // Explicit opt-in, string-matched on purpose (z.coerce.boolean() treats
  // the STRING "false" as truthy via Boolean("false") -- a classic zod
  // footgun for env-var booleans). Defaults to false so any real deploy
  // that never sets this var is safe by default; local dev turns it on
  // via .env.example. Never set this in Railway/production.
  ALLOW_DEV_KEY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DATABASE_URL: z.string().optional(),
  HELIUS_API_KEY: z.string().optional(),
  ALCHEMY_API_KEY: z.string().optional(),
  JUPITER_API_BASE_URL: z.string().url().default("https://price.jup.ag/v6"),
  // Extra CORS origins to allow, beyond the always-allowed bagged.life /
  // www.bagged.life / Vercel-preview-domain set hardcoded in src/app.ts.
  // Comma-separated exact origins, e.g.
  // "https://staging.bagged.life,http://localhost:3000". Optional -- no
  // code change needed for the common case, only for extending it.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // Optional Sentry DSN for error tracking/alerting (see src/lib/sentry.ts).
  // Unset by default -- Sentry stays fully inert (no init, no network
  // calls) until a real DSN is provided. Never required for local dev or
  // for the app to boot.
  SENTRY_DSN: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}

export const config = loadConfig();
