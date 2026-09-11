import type { Pool } from "pg";

export interface ApprovedEmail {
  id: string;
  email: string;
  approved_by: string;
  created_at: string;
  notes: string | null;
}

/**
 * Check if an email is approved for signup
 */
export async function isEmailApproved(db: Pool, email: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM approved_emails WHERE email = $1", [email.toLowerCase()]);
  return result.rows.length > 0;
}

/**
 * Get all approved emails
 */
export async function getApprovedEmails(db: Pool): Promise<ApprovedEmail[]> {
  const result = await db.query(
    "SELECT id, email, approved_by, created_at, notes FROM approved_emails ORDER BY created_at DESC"
  );
  return result.rows as ApprovedEmail[];
}

/**
 * Approve an email
 */
export async function approveEmail(db: Pool, email: string, approvedBy: string, notes?: string): Promise<void> {
  await db.query(
    "INSERT INTO approved_emails (email, approved_by, notes) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET approved_by = $2, notes = $3",
    [email.toLowerCase(), approvedBy, notes ?? null]
  );
}

/**
 * Revoke email approval
 */
export async function revokeEmailApproval(db: Pool, email: string): Promise<void> {
  await db.query("DELETE FROM approved_emails WHERE email = $1", [email.toLowerCase()]);
}
