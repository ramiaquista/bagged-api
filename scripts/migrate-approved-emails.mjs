#!/usr/bin/env node

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://bagged:bagged@localhost:5432/bagged';

async function migrate() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    console.log('Connecting to database...');
    console.log(`DATABASE_URL: ${DATABASE_URL.split('@')[1] || 'localhost'}`);

    // Test connection
    const testResult = await pool.query('SELECT NOW()');
    console.log('✓ Database connection successful');

    console.log('Creating approved_emails table...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS approved_emails (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE,
        notes text,
        approved_by text NOT NULL DEFAULT 'admin',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    console.log('✓ approved_emails table created successfully');

    // Verify the table exists
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'approved_emails'
      );
    `);

    if (result.rows[0]?.exists) {
      console.log('✓ Migration verified: table exists');
    } else {
      throw new Error('Migration verification failed: table not found');
    }
  } catch (error) {
    console.error('✗ Migration failed:');
    if (error instanceof Error) {
      console.error('  Message:', error.message);
      console.error('  Code:', error.code);
    } else {
      console.error('  Error:', error);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
