import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { StoredTier } from "../lib/tiers.js";

/** Prefix on every issued plaintext key, purely for eyeballing key type in logs/UIs. */
const KEY_PREFIX = "bg";

export interface ApiKeyRecord {
  id: string;
  ownerEmail: string;
  tier: StoredTier;
  /** `partners.id` this key traces back to, or `null` for a key issued by hand from /admin. */
  partnerId: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

interface ApiKeyRow {
  id: string;
  owner_email: string;
  tier: StoredTier;
  partner_id: string | null;
  created_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    tier: row.tier,
    partnerId: row.partner_id,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}

const API_KEY_ROW_COLUMNS = "id, owner_email, tier, partner_id, created_at, revoked_at, last_used_at";

/**
 * Only a hash of the plaintext key is ever persisted (see `api_keys.key_hash`
 * in db/schema.sql) -- sha256 is enough here since the input space is a full
 * random 24-byte token (see generatePlaintextKey), not a low-entropy
 * user-chosen secret that would need a slow/salted KDF like bcrypt/argon2.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generatePlaintextKey(): string {
  return `${KEY_PREFIX}_${randomBytes(24).toString("hex")}`;
}

/**
 * Issues a brand-new key for a customer. The plaintext is returned exactly
 * once here -- it is never stored or retrievable again, matching how the
 * rest of the industry treats API keys (only the hash lives in Postgres).
 *
 * `partnerId` defaults to `null` (a key issued by hand from /admin, see
 * src/routes/admin.ts, isn't linked to any self-serve account) -- pass it
 * only from src/routes/partner.ts, where a signed-in partner is issuing a
 * key for themselves.
 */
export async function createApiKey(
  db: Pool,
  ownerEmail: string,
  tier: StoredTier,
  partnerId: string | null = null,
): Promise<{ record: ApiKeyRecord; plaintext: string }> {
  const plaintext = generatePlaintextKey();
  const keyHash = hashApiKey(plaintext);

  const result = await db.query<ApiKeyRow>(
    `insert into api_keys (key_hash, owner_email, tier, partner_id)
     values ($1, $2, $3, $4)
     returning ${API_KEY_ROW_COLUMNS}`,
    [keyHash, ownerEmail, tier, partnerId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insert into api_keys returned no row");
  }
  return { record: toRecord(row), plaintext };
}

/**
 * Rotates a key: atomically revokes the existing row and issues a new one
 * for the same owner/tier/partner. Done in a transaction so a crash between
 * the two steps can't leave a customer with zero working keys and no record
 * of a replacement having been created. Carries `partner_id` forward so a
 * partner-owned key stays partner-owned after rotation -- otherwise a
 * partner rotating their own key from /b2b-dashboard would create a new
 * row /admin thinks it owns instead.
 */
export async function rotateApiKey(
  db: Pool,
  apiKeyId: string,
): Promise<{ record: ApiKeyRecord; plaintext: string }> {
  const client = await db.connect();
  try {
    await client.query("begin");

    const existing = await client.query<ApiKeyRow>(
      `select ${API_KEY_ROW_COLUMNS} from api_keys where id = $1 for update`,
      [apiKeyId],
    );
    const old = existing.rows[0];
    if (!old) {
      throw new Error(`no api key found with id ${apiKeyId}`);
    }

    await client.query(`update api_keys set revoked_at = now() where id = $1`, [apiKeyId]);

    const plaintext = generatePlaintextKey();
    const keyHash = hashApiKey(plaintext);
    const inserted = await client.query<ApiKeyRow>(
      `insert into api_keys (key_hash, owner_email, tier, partner_id)
       values ($1, $2, $3, $4)
       returning ${API_KEY_ROW_COLUMNS}`,
      [keyHash, old.owner_email, old.tier, old.partner_id],
    );
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("insert into api_keys returned no row during rotation");
    }

    await client.query("commit");
    return { record: toRecord(row), plaintext };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Idempotent: returns `false` if the key doesn't exist or was already revoked. */
export async function revokeApiKey(db: Pool, apiKeyId: string): Promise<boolean> {
  const result = await db.query(
    `update api_keys set revoked_at = now() where id = $1 and revoked_at is null`,
    [apiKeyId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** By id, regardless of revoked state -- used by src/routes/partner.ts to check key ownership before rotate/revoke. */
export async function findApiKeyById(db: Pool, apiKeyId: string): Promise<ApiKeyRecord | null> {
  const result = await db.query<ApiKeyRow>(`select ${API_KEY_ROW_COLUMNS} from api_keys where id = $1`, [
    apiKeyId,
  ]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/**
 * The one lookup on the request hot path (src/plugins/apiKey.ts): resolves
 * a caller-supplied key to its record, or `null` if it doesn't exist or has
 * been revoked. Revoked keys are excluded at the query level rather than
 * checked after the fact, so there's no way to accidentally treat a revoked
 * key as valid just because a caller forgot to check `revokedAt`.
 */
export async function findActiveApiKeyByHash(db: Pool, keyHash: string): Promise<ApiKeyRecord | null> {
  const result = await db.query<ApiKeyRow>(
    `select ${API_KEY_ROW_COLUMNS} from api_keys where key_hash = $1 and revoked_at is null`,
    [keyHash],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** For the key-management script's `list` command; optionally scoped to one owner. */
export async function listApiKeys(db: Pool, ownerEmail?: string): Promise<ApiKeyRecord[]> {
  const result = ownerEmail
    ? await db.query<ApiKeyRow>(
        `select ${API_KEY_ROW_COLUMNS} from api_keys where owner_email = $1 order by created_at asc`,
        [ownerEmail],
      )
    : await db.query<ApiKeyRow>(`select ${API_KEY_ROW_COLUMNS} from api_keys order by created_at asc`);
  return result.rows.map(toRecord);
}

/**
 * For `/partner/api-keys` (src/routes/partner.ts): every key traced back to
 * one partner account, by `partner_id` rather than `owner_email` -- a
 * partner must only ever see keys actually linked to their account, not
 * every key that happens to share their email string (e.g. one issued by
 * hand from /admin before they signed up).
 */
export async function listApiKeysForPartner(db: Pool, partnerId: string): Promise<ApiKeyRecord[]> {
  const result = await db.query<ApiKeyRow>(
    `select ${API_KEY_ROW_COLUMNS} from api_keys where partner_id = $1 order by created_at asc`,
    [partnerId],
  );
  return result.rows.map(toRecord);
}

/** How many non-revoked keys a partner currently holds -- used to cap self-serve key creation (see PARTNER_MAX_ACTIVE_KEYS in src/routes/partner.ts). */
export async function countActiveApiKeysForPartner(db: Pool, partnerId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count from api_keys where partner_id = $1 and revoked_at is null`,
    [partnerId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/** One-minute buckets -- see the comment above `api_key_usage` in db/schema.sql. */
const USAGE_WINDOW_MS = 60_000;

/** Rounds a timestamp down to its enclosing usage window, exported so tests can compute the same bucket independently. */
export function usageWindowStart(at: Date = new Date()): Date {
  return new Date(Math.floor(at.getTime() / USAGE_WINDOW_MS) * USAGE_WINDOW_MS);
}

/**
 * Increments the current window's request counter for a key, creating the
 * row on first use in that window. Also stamps `api_keys.last_used_at` for
 * quick visibility (e.g. `manage-api-key.ts list`) without joining against
 * usage buckets. Only called for requests that resolve to a real
 * `api_keys` row (src/plugins/apiKey.ts) -- the legacy shared-secret/dev-key
 * paths have no id to attribute usage to.
 *
 * Does NOT enforce any limit -- that's src/plugins/rateLimit.ts's job. This
 * is purely bookkeeping so that plugin (and /partner/usage, see
 * src/routes/partner.ts) has real counters to read.
 */
export async function recordApiKeyUsage(db: Pool, apiKeyId: string, at: Date = new Date()): Promise<void> {
  const windowStart = usageWindowStart(at);
  await db.query(
    `insert into api_key_usage (api_key_id, window_start, request_count)
     values ($1, $2, 1)
     on conflict (api_key_id, window_start)
     do update set request_count = api_key_usage.request_count + 1`,
    [apiKeyId, windowStart],
  );
  await db.query(`update api_keys set last_used_at = now() where id = $1`, [apiKeyId]);
}

/** Reads back a single window's counter -- mainly a test helper. */
export async function getUsageCount(db: Pool, apiKeyId: string, windowStart: Date): Promise<number> {
  const result = await db.query<{ request_count: string }>(
    `select request_count::text from api_key_usage where api_key_id = $1 and window_start = $2`,
    [apiKeyId, windowStart],
  );
  return Number(result.rows[0]?.request_count ?? "0");
}

/**
 * Sums `request_count` across every usage bucket at or after `since`, for
 * one key. Backs `GET /partner/usage` (src/routes/partner.ts) -- "requests
 * in the last hour" / "requests in the last 24 hours" against a partner's
 * key(s), read from the same durable Postgres counters
 * src/plugins/rateLimit.ts's in-memory limiter is a fast approximation of
 * (see that file's comment on the split between the two).
 */
export async function getUsageSince(db: Pool, apiKeyId: string, since: Date): Promise<number> {
  const result = await db.query<{ total: string | null }>(
    `select sum(request_count)::text as total from api_key_usage where api_key_id = $1 and window_start >= $2`,
    [apiKeyId, since],
  );
  return Number(result.rows[0]?.total ?? "0");
}
