import type { Pool } from "pg";

/** One row of `api_request_log` (db/schema.sql) -- see that table's comment for scope/retention notes. */
export interface RequestLogEntry {
  id: string;
  method: string;
  path: string;
  statusCode: number;
  createdAt: string;
}

interface RequestLogRow {
  id: string;
  method: string;
  path: string;
  status_code: number;
  created_at: Date;
}

function toEntry(row: RequestLogRow): RequestLogEntry {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Records one request against a real `api_keys` row. Written from an
 * `onResponse` hook (src/plugins/requestLog.ts) so `statusCode` is known --
 * unlike `recordApiKeyUsage` (src/db/apiKeys.ts), which runs on `onRequest`
 * and so can never know how the request turned out. Best-effort by
 * convention at the call site: a logging failure must never affect the
 * response already sent to the caller.
 */
export async function recordRequestLog(
  db: Pool,
  apiKeyId: string,
  method: string,
  path: string,
  statusCode: number,
): Promise<void> {
  await db.query(
    `insert into api_request_log (api_key_id, method, path, status_code)
     values ($1, $2, $3, $4)`,
    [apiKeyId, method, path, statusCode],
  );
}

const DEFAULT_LOG_LIMIT = 100;

/**
 * Most recent request-log rows across a set of api_key ids (a partner may
 * hold more than one key -- see `GET /partner/logs` in
 * src/routes/partner.ts), newest first, capped at `limit`. `apiKeyIds`
 * empty short-circuits to `[]` rather than issuing a query with an empty
 * `= any($1)` array (which is valid SQL and would just return no rows
 * anyway, but skipping the round trip is cheap and makes the "no keys yet"
 * case explicit).
 */
export async function listRequestLogs(
  db: Pool,
  apiKeyIds: string[],
  limit: number = DEFAULT_LOG_LIMIT,
): Promise<RequestLogEntry[]> {
  if (apiKeyIds.length === 0) return [];
  const result = await db.query<RequestLogRow>(
    `select id, method, path, status_code, created_at
     from api_request_log
     where api_key_id = any($1)
     order by created_at desc
     limit $2`,
    [apiKeyIds, limit],
  );
  return result.rows.map(toEntry);
}
