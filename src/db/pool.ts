import { Pool } from "pg";
import { config } from "../config.js";

/**
 * Thin wrapper around `pg`'s connection pool. Chosen over the `postgres`
 * package because it's the most widely used/battle-tested Postgres client
 * for Node, has first-class TypeScript types (`@types/pg`), and needs no
 * extra config to work well with Fastify's request lifecycle.
 *
 * The pool itself is cheap to construct -- it doesn't open a connection
 * until the first query runs -- so it's safe to create one per `buildApp()`
 * call (see src/plugins/db.ts) without worrying about wasted sockets in
 * routes/tests that never touch the database.
 */
export function createPool(): Pool {
  return new Pool({ connectionString: config.DATABASE_URL });
}
