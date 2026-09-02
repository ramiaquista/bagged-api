import type { Pool, PoolClient } from "pg";
import type { WaitlistEntry, WaitlistSignupRequest } from "../schemas/waitlist.js";

interface WaitlistRow {
  email: string;
  note: string | null;
  created_at: Date;
}

function toEntry(row: WaitlistRow): WaitlistEntry {
  return {
    email: row.email,
    ...(row.note !== null ? { note: row.note } : {}),
    created_at: row.created_at.toISOString(),
  };
}

/**
 * Inserts a signup, relying on the `waitlist.email` unique constraint (see
 * db/schema.sql) to make dedup atomic -- two concurrent requests for the
 * same email can't both "win" the way a check-then-set on an in-memory Map
 * could race. `inserted: false` means the email was already on the list.
 *
 * Email is expected to already be lowercased by
 * WaitlistSignupSchema (src/schemas/waitlist.ts) before it gets here.
 *
 * Accepts a `Pool` or a checked-out `PoolClient` so `POST /waitlist` (see
 * src/routes/waitlist.ts) can run this insert inside the same transaction
 * as the api-key creation that follows it -- mirroring the
 * `begin`/`commit`/`rollback` pattern `rotateApiKey` already uses in
 * src/db/apiKeys.ts, so there's one transaction pattern in the codebase,
 * not two.
 */
export async function insertWaitlistSignup(
  db: Pool | PoolClient,
  signup: WaitlistSignupRequest,
): Promise<{ inserted: boolean }> {
  const result = await db.query<WaitlistRow>(
    `insert into waitlist (email, note)
     values ($1, $2)
     on conflict (email) do nothing
     returning email, note, created_at`,
    [signup.email, signup.note ?? null],
  );

  return { inserted: result.rows.length > 0 };
}

export async function listWaitlistEntries(db: Pool): Promise<WaitlistEntry[]> {
  const result = await db.query<WaitlistRow>(
    `select email, note, created_at from waitlist order by created_at asc`,
  );
  return result.rows.map(toEntry);
}

export async function countWaitlistEntries(db: Pool): Promise<number> {
  const result = await db.query<{ count: string }>(`select count(*)::text as count from waitlist`);
  return Number(result.rows[0]?.count ?? "0");
}
