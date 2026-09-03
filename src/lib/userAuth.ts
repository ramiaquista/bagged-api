import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Real self-serve login for bagged-website's `/app` -- individuals sign
 * themselves up with an email + password to track their own wallets' PnL.
 * A third, fully independent auth domain alongside the internal /admin
 * dashboard (one hardcoded operator, no signup, src/lib/adminAuth.ts) and
 * the self-serve /b2b-dashboard (any number of API-customer accounts,
 * src/lib/partnerAuth.ts): `/app` users never touch the API-key surface at
 * all, and a `/partner` or `/admin` session doesn't authenticate here and
 * vice versa.
 *
 * Deliberately its own module rather than a refactor of partnerAuth.ts,
 * even though the password-hashing and signed-cookie mechanics are
 * identical -- same reasoning as partnerAuth.ts's own doc comment: keeping
 * three parallel, independently-rotatable auth modules is a small amount
 * of duplication in exchange for never risking already-shipped /admin or
 * /partner auth while building the third one.
 */

const SCRYPT_KEY_LENGTH = 64;

/** Name of the cookie carrying the signed consumer session token. */
export const USER_SESSION_COOKIE = "bagged_user_session";

/**
 * How long a consumer session stays valid. Matches PARTNER_SESSION_TTL_MS's
 * reasoning (src/lib/partnerAuth.ts): a self-serve, come-back-often
 * dashboard, not a single operator re-authenticating at a desk.
 */
export const USER_SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

/** Hashes a plaintext user password for storage in `users.password_hash`. Same scrypt KDF as partnerAuth.ts's hashPartnerPassword -- see that function's doc comment. */
export function hashUserPassword(plaintext: string): string {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(plaintext, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `${salt}:${derivedKey}`;
}

/** Verifies a plaintext password against a `hashUserPassword` output. Constant-time comparison, same reasoning as partnerAuth.ts's verifyPartnerPassword. */
export function verifyUserPassword(plaintext: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(plaintext, salt, SCRYPT_KEY_LENGTH);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

interface SessionPayload {
  /** The signed-in user's `users.id`. */
  sub: string;
  exp: number;
}

/**
 * Issues a signed session token for one user: a base64url JSON payload
 * plus an HMAC-SHA256 signature over it, joined as `payload.signature`.
 * Same hand-rolled-over-JWT-library reasoning as
 * createPartnerSessionToken (src/lib/partnerAuth.ts).
 */
export function createUserSessionToken(secret: string, userId: string, ttlMs: number = USER_SESSION_TTL_MS): string {
  const payload: SessionPayload = { sub: userId, exp: Date.now() + ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

/**
 * Verifies a token produced by `createUserSessionToken`: signature must
 * match (constant-time) and the token must not be expired. Returns the
 * signed-in user's id on success, `null` for anything malformed, unsigned,
 * or expired.
 */
export function verifyUserSessionToken(secret: string, token: string | undefined): string | null {
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
