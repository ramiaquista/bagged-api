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
  // --- Admin dashboard auth (bagged-website's /admin) ---
  // A real login for the one operator account, NOT the shared secret
  // above -- API_KEY_SECRET / the dev key deliberately no longer grant
  // /admin access (see src/plugins/apiKey.ts's /admin exemption and
  // src/routes/admin.ts / src/lib/adminAuth.ts). No user table: there is
  // exactly one admin today.
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  // `<saltHex>:<scryptHashHex>`, produced by `npm run admin:hash-password`
  // (scripts/hash-admin-password.ts) -- never a plaintext password. The
  // dev default below is the hash of "admin-dev-password" so local dev
  // works out of the box; change this in Railway/production exactly like
  // API_KEY_SECRET above.
  ADMIN_PASSWORD_HASH: z
    .string()
    .min(1)
    .default(
      "4b3fd450160c2d4b142ab0afd65255de:a3683f9381635ac75724080fe92923ddf02300d524c4bb98af04134d6da249530b65e58d3cfcac5e0ab5a8777407d1d8687b0a26b24a7da8b8a2962260a4e17d",
    ),
  // HMAC key that signs the admin session cookie (src/lib/adminAuth.ts).
  // Never leave this at the default in Railway/production -- anyone who
  // has it can forge a valid admin session without ever logging in.
  ADMIN_SESSION_SECRET: z.string().min(1).default("dev-session-secret-change-me"),
  // Defaults to the local docker-compose Postgres (same pattern as
  // API_KEY_SECRET above) so `npm run dev` / `npm test` work without extra
  // setup beyond `docker compose up -d`. Railway/production must set this
  // explicitly to the provisioned database's connection string.
  DATABASE_URL: z.string().min(1).default("postgres://bagged:bagged@localhost:5432/bagged"),
  HELIUS_API_KEY: z.string().optional(),
  ALCHEMY_API_KEY: z.string().optional(),
  // NOTE: the historical default here was "https://price.jup.ag/v6" (see
  // .env.example's original comment). That host is fully decommissioned --
  // it no longer even resolves DNS (verified live 2026-09-01 while wiring
  // up SolanaProvider for NEXT_STEPS.md Item 2). Jupiter has since
  // consolidated free/unauthenticated pricing under lite-api.jup.ag, with
  // the current price endpoint at /price/v3 (appended by
  // providers/solana/jupiterClient.ts). Updated the default so the
  // Solana provider's pricing calls actually work out of the box; still
  // fully overridable via the JUPITER_API_BASE_URL env var. See the Item 2
  // hand-off report for this deviation.
  JUPITER_API_BASE_URL: z.string().url().default("https://lite-api.jup.ag"),
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
  // --- Webhook delivery worker (NEXT_STEPS.md Item 6, src/worker/) ---
  // How often the worker re-checks every registered wallet's PnL. Default
  // is 5 minutes: frequent enough that a threshold-crossing customer
  // notices within a reasonable window, infrequent enough not to hammer
  // Helius/Alchemy on every registered wallet, every tick, forever. Tune
  // down for local testing via .env.
  WEBHOOK_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60_000),
  // Delivery retries per triggered webhook (in addition to the first
  // attempt), with exponential backoff starting at
  // WEBHOOK_DELIVERY_BACKOFF_MS and doubling each retry. Deliberately small
  // -- this is a v1 background worker, not a durable job queue.
  WEBHOOK_DELIVERY_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  WEBHOOK_DELIVERY_BACKOFF_MS: z.coerce.number().int().positive().default(500),
  // --- Waitlist signup notification email (src/lib/waitlistNotify.ts) ---
  // Optional Resend (https://resend.com) API key. Fully inert -- no
  // network call, no crash -- until set: notifyWaitlistSignup() no-ops
  // (logs a warning) with this unset, exactly like HELIUS_API_KEY /
  // ALCHEMY_API_KEY / SENTRY_DSN above. Key issuance on this route was
  // deliberately reverted to a manual, by-hand process (see commit
  // f791ae2) -- this is what makes "we'll follow up by email" (the
  // website's own CTA copy) actually happen instead of requiring someone
  // to remember to poll GET /waitlist.
  RESEND_API_KEY: z.string().optional(),
  // Where that notification email is sent. Defaults to the address
  // that's already public across the site (footer, CTA copy, docs).
  WAITLIST_NOTIFY_EMAIL: z.string().email().default("business@bagged.life"),
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
