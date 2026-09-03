import type { Pool } from "pg";

/** Public-safe view of a `partners` row -- never includes `password_hash`. */
export interface PartnerRecord {
  id: string;
  email: string;
  companyName: string | null;
  createdAt: string;
}

/** Internal view used only by login, where the hash is actually needed. */
interface PartnerWithHash extends PartnerRecord {
  passwordHash: string;
}

interface PartnerRow {
  id: string;
  email: string;
  password_hash: string;
  company_name: string | null;
  created_at: Date;
}

function toRecord(row: PartnerRow): PartnerWithHash {
  return {
    id: row.id,
    email: row.email,
    companyName: row.company_name,
    createdAt: row.created_at.toISOString(),
    passwordHash: row.password_hash,
  };
}

/** Strips `passwordHash` before a record ever leaves the db layer for a route to return. */
export function toPublicRecord(record: PartnerWithHash): PartnerRecord {
  return { id: record.id, email: record.email, companyName: record.companyName, createdAt: record.createdAt };
}

const PARTNER_ROW_COLUMNS = "id, email, password_hash, company_name, created_at";

/** Postgres unique-violation error code, thrown on a duplicate `email`. */
const UNIQUE_VIOLATION = "23505";

export class PartnerEmailTakenError extends Error {
  constructor(email: string) {
    super(`A partner account already exists for ${email}`);
    this.name = "PartnerEmailTakenError";
  }
}

/**
 * Creates a new partner account. `email` is expected already-lowercased
 * (src/schemas/partner.ts normalizes it, same convention as
 * src/schemas/waitlist.ts) -- the unique constraint on `partners.email`
 * is what actually enforces no-duplicates; this just turns Postgres's raw
 * 23505 into a typed error the signup route can turn into a clean 409
 * instead of a generic 500.
 */
export async function createPartner(
  db: Pool,
  email: string,
  passwordHash: string,
  companyName: string | null,
): Promise<PartnerRecord> {
  try {
    const result = await db.query<PartnerRow>(
      `insert into partners (email, password_hash, company_name)
       values ($1, $2, $3)
       returning ${PARTNER_ROW_COLUMNS}`,
      [email, passwordHash, companyName],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("insert into partners returned no row");
    }
    return toPublicRecord(toRecord(row));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === UNIQUE_VIOLATION) {
      throw new PartnerEmailTakenError(email);
    }
    throw err;
  }
}

/** For login only -- includes the password hash to verify against. Internal to this module's callers in routes/partner.ts. */
export async function findPartnerByEmailWithHash(db: Pool, email: string): Promise<PartnerWithHash | null> {
  const result = await db.query<PartnerRow>(`select ${PARTNER_ROW_COLUMNS} from partners where email = $1`, [
    email,
  ]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** Resolves a session cookie's `sub` claim to the signed-in partner's public profile. */
export async function findPartnerById(db: Pool, id: string): Promise<PartnerRecord | null> {
  const result = await db.query<PartnerRow>(`select ${PARTNER_ROW_COLUMNS} from partners where id = $1`, [id]);
  const row = result.rows[0];
  return row ? toPublicRecord(toRecord(row)) : null;
}
