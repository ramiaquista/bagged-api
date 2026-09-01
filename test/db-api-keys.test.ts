import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createApiKey,
  findActiveApiKeyByHash,
  getUsageCount,
  hashApiKey,
  listApiKeys,
  recordApiKeyUsage,
  revokeApiKey,
  rotateApiKey,
  usageWindowStart,
} from "../src/db/apiKeys.js";
import { createPool } from "../src/db/pool.js";

// Real integration tests against Postgres (see db/schema.sql's `api_keys`
// and `api_key_usage` tables), matching the pattern in test/waitlist.test.ts.
// Requires a reachable Postgres matching DATABASE_URL.
const pool = createPool();

beforeEach(async () => {
  await pool.query("truncate table api_key_usage, api_keys cascade");
});

afterAll(async () => {
  await pool.end();
});

describe("db/apiKeys", () => {
  describe("createApiKey", () => {
    it("returns a plaintext key and a record, and only stores the hash", async () => {
      const { record, plaintext } = await createApiKey(pool, "owner@example.com", "builder");

      expect(plaintext).toMatch(/^bg_[0-9a-f]{48}$/);
      expect(record.ownerEmail).toBe("owner@example.com");
      expect(record.tier).toBe("builder");
      expect(record.revokedAt).toBeNull();
      expect(record.lastUsedAt).toBeNull();

      const row = await pool.query("select key_hash from api_keys where id = $1", [record.id]);
      expect(row.rows[0].key_hash).toBe(hashApiKey(plaintext));
      expect(row.rows[0].key_hash).not.toBe(plaintext);
    });

    it("generates a different key on every call", async () => {
      const a = await createApiKey(pool, "owner@example.com", "free");
      const b = await createApiKey(pool, "owner@example.com", "free");
      expect(a.plaintext).not.toBe(b.plaintext);
      expect(a.record.id).not.toBe(b.record.id);
    });
  });

  describe("findActiveApiKeyByHash", () => {
    it("finds an active key by the hash of its plaintext", async () => {
      const { record, plaintext } = await createApiKey(pool, "owner@example.com", "growth");
      const found = await findActiveApiKeyByHash(pool, hashApiKey(plaintext));
      expect(found).toEqual(record);
    });

    it("returns null for a key that was never issued", async () => {
      const found = await findActiveApiKeyByHash(pool, hashApiKey("bg_totally-made-up"));
      expect(found).toBeNull();
    });

    it("returns null for a revoked key", async () => {
      const { record, plaintext } = await createApiKey(pool, "owner@example.com", "free");
      await revokeApiKey(pool, record.id);
      const found = await findActiveApiKeyByHash(pool, hashApiKey(plaintext));
      expect(found).toBeNull();
    });
  });

  describe("revokeApiKey", () => {
    it("marks a key revoked and is idempotent", async () => {
      const { record } = await createApiKey(pool, "owner@example.com", "free");

      const first = await revokeApiKey(pool, record.id);
      expect(first).toBe(true);

      const second = await revokeApiKey(pool, record.id);
      expect(second).toBe(false);

      const row = await pool.query("select revoked_at from api_keys where id = $1", [record.id]);
      expect(row.rows[0].revoked_at).not.toBeNull();
    });

    it("returns false for a key id that doesn't exist", async () => {
      const revoked = await revokeApiKey(pool, "00000000-0000-4000-8000-000000000000");
      expect(revoked).toBe(false);
    });
  });

  describe("rotateApiKey", () => {
    it("revokes the old key and issues a new one for the same owner/tier", async () => {
      const original = await createApiKey(pool, "owner@example.com", "builder");

      const rotated = await rotateApiKey(pool, original.record.id);

      expect(rotated.record.id).not.toBe(original.record.id);
      expect(rotated.plaintext).not.toBe(original.plaintext);
      expect(rotated.record.ownerEmail).toBe("owner@example.com");
      expect(rotated.record.tier).toBe("builder");

      // Old key no longer authenticates.
      expect(await findActiveApiKeyByHash(pool, hashApiKey(original.plaintext))).toBeNull();
      // New key does.
      expect(await findActiveApiKeyByHash(pool, hashApiKey(rotated.plaintext))).toEqual(rotated.record);
    });

    it("throws for an unknown key id, leaving nothing revoked", async () => {
      await expect(rotateApiKey(pool, "00000000-0000-4000-8000-000000000000")).rejects.toThrow();
    });
  });

  describe("listApiKeys", () => {
    it("lists all keys, optionally filtered by owner", async () => {
      await createApiKey(pool, "alice@example.com", "free");
      await createApiKey(pool, "bob@example.com", "growth");

      const all = await listApiKeys(pool);
      expect(all).toHaveLength(2);

      const aliceOnly = await listApiKeys(pool, "alice@example.com");
      expect(aliceOnly).toHaveLength(1);
      expect(aliceOnly[0]?.ownerEmail).toBe("alice@example.com");
    });
  });

  describe("recordApiKeyUsage", () => {
    it("increments the current window's counter and stamps last_used_at", async () => {
      const { record } = await createApiKey(pool, "owner@example.com", "free");
      const at = new Date();

      await recordApiKeyUsage(pool, record.id, at);
      await recordApiKeyUsage(pool, record.id, at);

      const count = await getUsageCount(pool, record.id, usageWindowStart(at));
      expect(count).toBe(2);

      const row = await pool.query("select last_used_at from api_keys where id = $1", [record.id]);
      expect(row.rows[0].last_used_at).not.toBeNull();
    });

    it("buckets usage into separate windows", async () => {
      const { record } = await createApiKey(pool, "owner@example.com", "free");
      const windowA = new Date("2026-01-01T00:00:10.000Z");
      const windowB = new Date("2026-01-01T00:01:10.000Z");

      await recordApiKeyUsage(pool, record.id, windowA);
      await recordApiKeyUsage(pool, record.id, windowB);

      expect(await getUsageCount(pool, record.id, usageWindowStart(windowA))).toBe(1);
      expect(await getUsageCount(pool, record.id, usageWindowStart(windowB))).toBe(1);
    });
  });
});
