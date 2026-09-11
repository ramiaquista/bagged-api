#!/usr/bin/env node

/**
 * Migration script: Create the approved_emails table for email approval system.
 * Run with: npx ts-node scripts/migrate-approved-emails.ts
 */

import { createPool } from "../src/db/pool.js";

async function migrate() {
  const pool = createPool();

  try {
    console.log("Creating approved_emails table...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS approved_emails (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE,
        notes text,
        approved_by text NOT NULL DEFAULT 'admin',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    console.log("✓ approved_emails table created successfully");

    // Verify the table exists
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'approved_emails'
      );
    `);

    if (result.rows[0]?.exists) {
      console.log("✓ Migration verified: table exists");
    } else {
      throw new Error("Migration verification failed: table not found");
    }
  } catch (error) {
    console.error("✗ Migration failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
