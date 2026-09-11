#!/usr/bin/env node

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://bagged:bagged@localhost:5432/bagged';

async function clearWaitlist() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    console.log('Connecting to database...');

    // Test connection
    const testResult = await pool.query('SELECT NOW()');
    console.log('✓ Database connection successful');

    console.log('Clearing waitlist table...');

    const result = await pool.query('DELETE FROM waitlist');
    console.log(`✓ Deleted ${result.rowCount} waitlist entries`);

    // Verify
    const countResult = await pool.query('SELECT COUNT(*) FROM waitlist');
    const count = parseInt(countResult.rows[0]?.count || '0');
    console.log(`✓ Waitlist now has ${count} entries`);
  } catch (error) {
    console.error('✗ Error clearing waitlist:');
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

clearWaitlist();
