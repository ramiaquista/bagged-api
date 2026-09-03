import type { Pool } from "pg";
import type { DailyRealizedPnl } from "../providers/types.js";

interface DailyRealizedPnlRow {
  wallet_id: string;
  /** pg parses a `date` column as a JS `Date` at UTC midnight by default. */
  day: Date;
  realized_pnl_usd: string;
  trade_count: number;
}

/**
 * Re-derives the "YYYY-MM-DD" string from the driver's UTC-midnight `Date`
 * -- keeps this table's day-bucketing byte-for-byte consistent with
 * providers/solana.ts's getWalletDailyRealizedPnl, which produces the same
 * "YYYY-MM-DD" shape directly from trade timestamps.
 */
function toRecord(row: DailyRealizedPnlRow): { walletId: string } & DailyRealizedPnl {
  return {
    walletId: row.wallet_id,
    day: row.day.toISOString().slice(0, 10),
    realizedPnlUsd: Number(row.realized_pnl_usd),
    tradeCount: row.trade_count,
  };
}

/**
 * Replaces every stored day for `walletId` with a freshly computed set
 * (src/worker/dailyPnlWorker.ts). Wholesale delete-then-insert inside one
 * transaction, not a per-day upsert loop: a wash-trade reclassification or
 * newly-indexed older fill can change which days have *any* realized PnL
 * at all (not just their amounts), and a stale day left over from a prior
 * computation would otherwise never get cleaned up. `days` may be empty
 * (a wallet with no realized PnL in its indexed window) -- that still
 * clears out any previously-stored (now-stale) rows for it.
 */
export async function replaceDailyRealizedPnl(db: Pool, walletId: string, days: DailyRealizedPnl[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(`delete from daily_realized_pnl where wallet_id = $1`, [walletId]);
    for (const d of days) {
      await client.query(
        `insert into daily_realized_pnl (wallet_id, day, realized_pnl_usd, trade_count)
         values ($1, $2, $3, $4)`,
        [walletId, d.day, d.realizedPnlUsd, d.tradeCount],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Every stored daily-realized-PnL row for the given wallets, within [fromDay, toDay] inclusive ("YYYY-MM-DD" strings), for the monthly calendar. */
export async function listDailyRealizedPnl(
  db: Pool,
  walletIds: string[],
  fromDay: string,
  toDay: string,
): Promise<({ walletId: string } & DailyRealizedPnl)[]> {
  if (walletIds.length === 0) return [];
  const result = await db.query<DailyRealizedPnlRow>(
    `select wallet_id, day, realized_pnl_usd, trade_count
     from daily_realized_pnl
     where wallet_id = any($1::uuid[]) and day >= $2::date and day <= $3::date
     order by day asc`,
    [walletIds, fromDay, toDay],
  );
  return result.rows.map(toRecord);
}

/** Sum of realized PnL across the given wallets within [fromDay, toDay] inclusive -- the hero card's range-scoped "Realized" figure. */
export async function sumRealizedPnl(db: Pool, walletIds: string[], fromDay: string, toDay: string): Promise<number> {
  if (walletIds.length === 0) return 0;
  const result = await db.query<{ total: string | null }>(
    `select sum(realized_pnl_usd)::text as total
     from daily_realized_pnl
     where wallet_id = any($1::uuid[]) and day >= $2::date and day <= $3::date`,
    [walletIds, fromDay, toDay],
  );
  return Number(result.rows[0]?.total ?? 0);
}
