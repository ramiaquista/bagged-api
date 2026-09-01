import type { OriginFunction } from "@fastify/cors";
import type { Config } from "../config.js";

/**
 * Always-allowed origins: the production marketing site and its `www`
 * alias. These are never affected by CORS_ALLOWED_ORIGINS.
 */
const STATIC_ALLOWED_ORIGINS = new Set(["https://bagged.life", "https://www.bagged.life"]);

/**
 * Vercel preview-deploy pattern for the `bagged-website` project.
 *
 * ASSUMPTION: no `vercel.json` or team/org name was found in this repo to
 * confirm the exact preview URL shape, so this matches Vercel's generic
 * convention for a project named "bagged-website" (from its
 * package.json `name`): `https://bagged-website-<anything>.vercel.app`.
 * That covers both the per-commit hash form
 * (`bagged-website-<hash>-<team>.vercel.app`) and the per-branch form
 * (`bagged-website-git-<branch>-<team>.vercel.app`). If the real Vercel
 * project uses a different slug or a custom domain for previews, update
 * this pattern (or set CORS_ALLOWED_ORIGINS) accordingly.
 */
const VERCEL_PREVIEW_PATTERN = /^https:\/\/bagged-website-[a-z0-9-]+\.vercel\.app$/;

/**
 * Parses CORS_ALLOWED_ORIGINS ("origin,origin,...") into a Set of exact
 * origin strings. Blank/whitespace-only entries are dropped.
 */
export function parseExtraAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Returns true if `origin` should be allowed to make cross-origin requests.
 *
 * `origin` is `undefined` for non-browser requests (curl, server-to-server,
 * same-origin) -- @fastify/cors only invokes this for requests that carry
 * an `Origin` header, but we treat a missing one as allowed defensively.
 */
export function isOriginAllowed(
  origin: string | undefined,
  extraAllowedOrigins: Set<string>,
): boolean {
  if (!origin) return true;
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  if (VERCEL_PREVIEW_PATTERN.test(origin)) return true;
  if (extraAllowedOrigins.has(origin)) return true;
  return false;
}

/**
 * Builds the `origin` option for @fastify/cors from config.
 */
export function buildCorsOriginOption(
  config: Pick<Config, "CORS_ALLOWED_ORIGINS">,
): OriginFunction {
  const extra = parseExtraAllowedOrigins(config.CORS_ALLOWED_ORIGINS);
  return (origin, cb) => {
    cb(null, isOriginAllowed(origin, extra));
  };
}
