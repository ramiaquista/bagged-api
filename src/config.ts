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
  // Defaults to the local docker-compose Postgres (same pattern as
  // API_KEY_SECRET above) so `npm run dev` / `npm test` work without extra
  // setup beyond `docker compose up -d`. Railway/production must set this
  // explicitly to the provisioned database's connection string.
  DATABASE_URL: z.string().min(1).default("postgres://bagged:bagged@localhost:5432/bagged"),
  HELIUS_API_KEY: z.string().optional(),
  ALCHEMY_API_KEY: z.string().optional(),
  JUPITER_API_BASE_URL: z.string().url().default("https://price.jup.ag/v6"),
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
