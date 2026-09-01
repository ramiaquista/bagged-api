import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Pool } from "pg";
import { createPool } from "../db/pool.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
  }
}

/**
 * Decorates the Fastify instance with a Postgres connection pool
 * (`app.db`), and ties its lifecycle to the app's: closing the app (e.g.
 * `app.close()` in tests, or a graceful shutdown in production) drains and
 * closes the pool too, so nothing leaks connections or keeps the process
 * alive.
 */
export default fp(async function dbPlugin(app: FastifyInstance) {
  const pool = createPool();
  app.decorate("db", pool);
  app.addHook("onClose", async () => {
    await pool.end();
  });
});
