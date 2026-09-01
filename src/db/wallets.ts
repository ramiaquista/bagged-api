import type { Pool } from "pg";
import type { Chain } from "../schemas/chain.js";

export interface WalletRecord {
  id: string;
  chain: Chain;
  address: string;
}

/**
 * Finds the `wallets` row for (chain, address), creating it on first sight.
 * Shared by src/db/webhooks.ts (a webhook registration is the first time a
 * wallet is "known" to Bagged in some cases) and src/worker/webhookWorker.ts
 * (needs `wallet_id` to write `pnl_snapshots`).
 *
 * Uses `on conflict ... do update` (a no-op-shaped update -- `address` is
 * part of the conflict target, so it never actually changes) rather than
 * `do nothing`, purely so a concurrent insert racing this one still returns
 * a row via `returning` instead of forcing a second round-trip select.
 */
export async function findOrCreateWallet(db: Pool, chain: Chain, address: string): Promise<WalletRecord> {
  const result = await db.query<WalletRecord>(
    `insert into wallets (chain, address)
     values ($1, $2)
     on conflict (chain, address) do update set address = excluded.address
     returning id, chain, address`,
    [chain, address],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insert into wallets returned no row");
  }
  return row;
}
