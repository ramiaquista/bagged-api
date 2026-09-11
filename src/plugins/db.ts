import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Pool } from "pg";
import { createPool } from "../db/pool.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
  }
}

async function runMigrations(pool: Pool, log: FastifyInstance["log"]) {
  try {
    // Create approved_emails table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS approved_emails (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE,
        notes text,
        approved_by text NOT NULL DEFAULT 'admin',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  } catch (error) {
    // Log migration errors but don't fail startup -- a concurrent migration
    // might have already created the table (race condition in multi-instance deployments)
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Migration warning: ${msg}`);
  }
}

/**
 * Decorates the Fastify instance with a Postgres connection pool
 * (`app.db`), and ties its lifecycle to the app's: closing the app (e.g.
 * `app.close()` in tests, or a graceful shutdown in production) drains and
 * closes the pool too, so nothing leaks connections or keeps the process
 * alive.
 *
 * Runs database migrations on startup to ensure schema is up to date.
 */
export default fp(async function dbPlugin(app: FastifyInstance) {
  const pool = createPool();
  app.decorate("db", pool);

  // Run migrations on startup
  await runMigrations(pool, app.log);

  app.addHook("onClose", async () => {
    await pool.end();
  });
});
