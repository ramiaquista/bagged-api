import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Real login for the single-operator /admin dashboard (bagged-website's
 * `src/app/admin/**`), replacing the legacy shared-secret gate. The
 * `x-api-key` shared secret / `dev` key that authenticates the rest of the
 * product API (src/plugins/apiKey.ts) no longer grants admin access at
 * all -- see that plugin's `/admin` exemption and src/routes/admin.ts's
 * `requireAdminSession`.
 *
 * One admin account, credentials configured via env vars (ADMIN_USERNAME /
 * ADMIN_PASSWORD_HASH in src/config.ts) rather than a database table --
 * there is exactly one operator today (Rami). Session state is a signed,
 * stateless cookie (no server-side session store to invalidate against),
 * verified fresh on every /admin/* request.
 */

const SCRYPT_KEY_LENGTH = 64;

/** Name of the cookie carrying the signed session token. */
export const ADMIN_SESSION_COOKIE = "bagged_admin_session";

/** How long a session stays valid after a successful login. */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60_000; // 12 hours

/**
 * Hashes a plaintext admin password for storage in ADMIN_PASSWORD_HASH.
 * Uses scrypt -- not the plain sha256 src/db/apiKeys.ts's `hashApiKey`
 * uses -- because a human-chosen password is far lower entropy than a
 * random 24-byte API key and needs a slow, salted KDF to resist offline
 * brute-forcing if the stored hash ever leaks. Stored as
 * `<saltHex>:<derivedKeyHex>`.
 */
export function hashAdminPassword(plaintext: string): string {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(plaintext, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `${salt}:${derivedKey}`;
}

/**
 * Verifies a plaintext password against a `hashAdminPassword` output.
 * Constant-time comparison (`timingSafeEqual`) -- a plain `===` on the
 * derived key would leak how many leading bytes matched through timing.
 */
export function verifyAdminPassword(plaintext: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(plaintext, salt, SCRYPT_KEY_LENGTH);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

interface SessionPayload {
  exp: number;
}

/**
 * Issues a signed session token: a base64url JSON payload plus an
 * HMAC-SHA256 signature over it, joined as `payload.signature`. Not a JWT
 * library -- there's exactly one static claim (expiry) to carry, so a
 * hand-rolled equivalent is simpler than a general-purpose JWT dependency
 * for it.
 */
export function createAdminSessionToken(secret: string, ttlMs: number = ADMIN_SESSION_TTL_MS): string {
  const payload: SessionPayload = { exp: Date.now() + ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

/**
 * Verifies a token produced by `createAdminSessionToken`: signature must
 * match (constant-time) and the token must not be expired. Returns false
 * for anything malformed rather than throwing -- callers treat "not a
 * valid session" as one outcome regardless of which check failed.
 */
export function verifyAdminSessionToken(secret: string, token: string | undefined): boolean {
  if (!token) return false;
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return false;

  const expectedSignature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as SessionPayload;
    return typeof payload.exp === "number" && Date.now() < payload.exp;
  } catch {
    return false;
  }
}
