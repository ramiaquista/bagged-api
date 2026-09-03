import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Real self-serve login for bagged-website's `/b2b-dashboard` -- partners
 * sign themselves up with an email + password (unlike the internal
 * /admin dashboard's single, env-configured operator account, see
 * src/lib/adminAuth.ts). Backed by the `partners` table (db/schema.sql,
 * data access in src/db/partners.ts) instead of an env var, since there
 * can be any number of partners.
 *
 * Deliberately its own module, not a refactor of adminAuth.ts, even though
 * the password-hashing and signed-cookie mechanics are nearly identical:
 * adminAuth.ts is already shipped and depended on by test/adminAuth.test.ts
 * / test/admin.test.ts, and the session payload shapes differ (admin has
 * no `sub` -- there's only one account; a partner session must carry
 * *which* partner is signed in). Keeping them separate avoids touching
 * working, already-deployed admin auth to add partner auth.
 */

const SCRYPT_KEY_LENGTH = 64;

/** Name of the cookie carrying the signed partner session token. */
export const PARTNER_SESSION_COOKIE = "bagged_partner_session";

/**
 * How long a partner session stays valid. Much longer than the admin
 * dashboard's 12 hours (src/lib/adminAuth.ts's ADMIN_SESSION_TTL_MS) --
 * that's a single operator re-authenticating at a desk periodically; this
 * is a self-serve developer dashboard, where "stay signed in" for weeks is
 * the expected UX (matches most API-provider dashboards).
 */
export const PARTNER_SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

/**
 * Hashes a plaintext partner password for storage in `partners.password_hash`.
 * Scrypt, not the plain sha256 src/db/apiKeys.ts's `hashApiKey` uses --
 * same rationale as ADMIN_PASSWORD_HASH (src/lib/adminAuth.ts): a
 * human-chosen password is far lower entropy than a random API key and
 * needs a slow, salted KDF. Stored as `<saltHex>:<derivedKeyHex>`.
 */
export function hashPartnerPassword(plaintext: string): string {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(plaintext, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `${salt}:${derivedKey}`;
}

/**
 * Verifies a plaintext password against a `hashPartnerPassword` output.
 * Constant-time comparison (`timingSafeEqual`) -- a plain `===` on the
 * derived key would leak how many leading bytes matched through timing.
 */
export function verifyPartnerPassword(plaintext: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(plaintext, salt, SCRYPT_KEY_LENGTH);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

interface SessionPayload {
  /** The signed-in partner's `partners.id`. */
  sub: string;
  exp: number;
}

/**
 * Issues a signed session token for one partner: a base64url JSON payload
 * plus an HMAC-SHA256 signature over it, joined as `payload.signature`.
 * Same hand-rolled-over-JWT-library reasoning as
 * createAdminSessionToken (src/lib/adminAuth.ts) -- two static claims
 * (`sub`, `exp`) don't justify a general-purpose JWT dependency.
 */
export function createPartnerSessionToken(
  secret: string,
  partnerId: string,
  ttlMs: number = PARTNER_SESSION_TTL_MS,
): string {
  const payload: SessionPayload = { sub: partnerId, exp: Date.now() + ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

/**
 * Verifies a token produced by `createPartnerSessionToken`: signature must
 * match (constant-time) and the token must not be expired. Returns the
 * signed-in partner's id on success, `null` for anything malformed,
 * unsigned, or expired -- callers treat "not a valid session" as one
 * outcome regardless of which check failed.
 */
export function verifyPartnerSessionToken(secret: string, token: string | undefined): string | null {
  if (!token) return null;
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;

  const expectedSignature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as SessionPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (Date.now() >= payload.exp) return null;
    return payload.sub;
  } catch {
    return null;
  }
}
