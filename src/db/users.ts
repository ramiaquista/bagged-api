import type { Pool } from "pg";

/** Public-safe view of a `users` row -- never includes `password_hash`. */
export interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

/** Internal view used only by login, where the hash is actually needed. */
interface UserWithHash extends UserRecord {
  passwordHash: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: Date;
}

function toRecord(row: UserRow): UserWithHash {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    passwordHash: row.password_hash,
  };
}

/** Strips `passwordHash` before a record ever leaves the db layer for a route to return. */
export function toPublicRecord(record: UserWithHash): UserRecord {
  return { id: record.id, email: record.email, displayName: record.displayName, createdAt: record.createdAt };
}

const USER_ROW_COLUMNS = "id, email, password_hash, display_name, created_at";

/** Postgres unique-violation error code, thrown on a duplicate `email`. */
const UNIQUE_VIOLATION = "23505";

export class UserEmailTakenError extends Error {
  constructor(email: string) {
    super(`An account already exists for ${email}`);
    this.name = "UserEmailTakenError";
  }
}

/**
 * Creates a new consumer account. `email` is expected already-lowercased
 * (src/schemas/user.ts normalizes it, same convention as
 * src/schemas/partner.ts) -- the unique constraint on `users.email` is
 * what actually enforces no-duplicates; this just turns Postgres's raw
 * 23505 into a typed error the signup route can turn into a clean 400
 * instead of a generic 500.
 */
export async function createUser(
  db: Pool,
  email: string,
  passwordHash: string,
  displayName: string | null,
): Promise<UserRecord> {
  try {
    const result = await db.query<UserRow>(
      `insert into users (email, password_hash, display_name)
       values ($1, $2, $3)
       returning ${USER_ROW_COLUMNS}`,
      [email, passwordHash, displayName],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("insert into users returned no row");
    }
    return toPublicRecord(toRecord(row));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === UNIQUE_VIOLATION) {
      throw new UserEmailTakenError(email);
    }
    throw err;
  }
}

/** For login only -- includes the password hash to verify against. Internal to this module's callers in routes/user.ts. */
export async function findUserByEmailWithHash(db: Pool, email: string): Promise<UserWithHash | null> {
  const result = await db.query<UserRow>(`select ${USER_ROW_COLUMNS} from users where email = $1`, [email]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** Resolves a session cookie's `sub` claim to the signed-in user's public profile. */
export async function findUserById(db: Pool, id: string): Promise<UserRecord | null> {
  const result = await db.query<UserRow>(`select ${USER_ROW_COLUMNS} from users where id = $1`, [id]);
  const row = result.rows[0];
  return row ? toPublicRecord(toRecord(row)) : null;
}
