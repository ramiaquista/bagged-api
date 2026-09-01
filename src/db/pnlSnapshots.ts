import type { Pool } from "pg";

export interface PnlSnapshotInput {
  walletId: string;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  positionsOpen: number;
  washTradesExcluded: number;
  rugsResolved: number;
}

export interface PnlSnapshotRecord extends PnlSnapshotInput {
  id: string;
  snapshotAt: string;
}

interface PnlSnapshotRow {
  id: string;
  wallet_id: string;
  realized_pnl_usd: string;
  unrealized_pnl_usd: string;
  positions_open: number;
  wash_trades_excluded: number;
  rugs_resolved: number;
  snapshot_at: Date;
}

function toRecord(row: PnlSnapshotRow): PnlSnapshotRecord {
  return {
    id: row.id,
    walletId: row.wallet_id,
    realizedPnlUsd: Number(row.realized_pnl_usd),
    unrealizedPnlUsd: Number(row.unrealized_pnl_usd),
    positionsOpen: row.positions_open,
    washTradesExcluded: row.wash_trades_excluded,
    rugsResolved: row.rugs_resolved,
    snapshotAt: row.snapshot_at.toISOString(),
  };
}

/**
 * Point-in-time PnL rollup for a wallet -- the `pnl_snapshots` table
 * (db/schema.sql), written once per wallet per webhook-worker check cycle
 * (src/worker/webhookWorker.ts). Also the intended source for the
 * currently-mocked GET /leaderboard once that's wired to real data
 * (NEXT_STEPS.md doesn't scope that to this item).
 */
export async function insertPnlSnapshot(db: Pool, input: PnlSnapshotInput): Promise<PnlSnapshotRecord> {
  const result = await db.query<PnlSnapshotRow>(
    `insert into pnl_snapshots
       (wallet_id, realized_pnl_usd, unrealized_pnl_usd, positions_open, wash_trades_excluded, rugs_resolved)
     values ($1, $2, $3, $4, $5, $6)
     returning id, wallet_id, realized_pnl_usd, unrealized_pnl_usd, positions_open, wash_trades_excluded, rugs_resolved, snapshot_at`,
    [
      input.walletId,
      input.realizedPnlUsd,
      input.unrealizedPnlUsd,
      input.positionsOpen,
      input.washTradesExcluded,
      input.rugsResolved,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insert into pnl_snapshots returned no row");
  }
  return toRecord(row);
}

/**
 * The most recent snapshot for a wallet, or `null` if it's never been
 * checked before. Callers (the webhook worker) should fetch this *before*
 * inserting the new snapshot for the current check, so it never matches
 * itself.
 */
export async function getLatestPnlSnapshot(db: Pool, walletId: string): Promise<PnlSnapshotRecord | null> {
  const result = await db.query<PnlSnapshotRow>(
    `select id, wallet_id, realized_pnl_usd, unrealized_pnl_usd, positions_open, wash_trades_excluded, rugs_resolved, snapshot_at
     from pnl_snapshots
     where wallet_id = $1
     order by snapshot_at desc
     limit 1`,
    [walletId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}
