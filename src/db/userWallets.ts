import type { Pool } from "pg";
import type { Chain } from "../schemas/chain.js";

/** One wallet linked into a user's tracked portfolio, joined with `wallets` for chain/address. */
export interface UserWalletRecord {
  /** `wallets.id` -- what routes/user.ts's unlink call and the daily-PnL worker key off of. */
  walletId: string;
  chain: Chain;
  address: string;
  label: string | null;
  linkedAt: string;
}

interface UserWalletRow {
  wallet_id: string;
  chain: Chain;
  address: string;
  label: string | null;
  linked_at: Date;
}

function toRecord(row: UserWalletRow): UserWalletRecord {
  return {
    walletId: row.wallet_id,
    chain: row.chain,
    address: row.address,
    label: row.label,
    linkedAt: row.linked_at.toISOString(),
  };
}

/** Postgres unique-violation error code -- thrown by the (user_id, wallet_id) primary key on a re-link attempt. */
const UNIQUE_VIOLATION = "23505";

export class WalletAlreadyLinkedError extends Error {
  constructor() {
    super("This wallet is already linked to your account");
    this.name = "WalletAlreadyLinkedError";
  }
}

/** What `linkWallet` returns -- just the `user_wallets` row itself; the caller (already holding chain/address from findOrCreateWallet) composes the full `UserWalletRecord`. */
export interface LinkedWallet {
  walletId: string;
  label: string | null;
  linkedAt: string;
}

/**
 * Links `walletId` (a `wallets` row -- see src/db/wallets.ts's
 * findOrCreateWallet, called first by the route) into `userId`'s tracked
 * portfolio. `on conflict` isn't used here (unlike findOrCreateWallet) --
 * re-linking an already-linked wallet is a user mistake worth a clear
 * error, not a silent no-op.
 */
export async function linkWallet(db: Pool, userId: string, walletId: string, label: string | null): Promise<LinkedWallet> {
  try {
    const result = await db.query<{ wallet_id: string; label: string | null; linked_at: Date }>(
      `insert into user_wallets (user_id, wallet_id, label)
       values ($1, $2, $3)
       returning wallet_id, label, linked_at`,
      [userId, walletId, label],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("insert into user_wallets returned no row");
    }
    return { walletId: row.wallet_id, label: row.label, linkedAt: row.linked_at.toISOString() };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === UNIQUE_VIOLATION) {
      throw new WalletAlreadyLinkedError();
    }
    throw err;
  }
}

/** Every wallet linked into `userId`'s tracked portfolio, newest-linked first. */
export async function listWalletsForUser(db: Pool, userId: string): Promise<UserWalletRecord[]> {
  const result = await db.query<UserWalletRow>(
    `select w.id as wallet_id, w.chain, w.address, uw.label, uw.linked_at
     from user_wallets uw
     join wallets w on w.id = uw.wallet_id
     where uw.user_id = $1
     order by uw.linked_at desc`,
    [userId],
  );
  return result.rows.map(toRecord);
}

/** How many wallets `userId` currently has linked -- a lightweight existence/cap check without fetching every row. */
export async function countWalletsForUser(db: Pool, userId: string): Promise<number> {
  const result = await db.query<{ count: string }>(`select count(*)::text as count from user_wallets where user_id = $1`, [
    userId,
  ]);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Unlinks a wallet from `userId`'s portfolio. Returns `true` if a row was
 * actually removed (scoped to `userId` in the `where` clause -- one user
 * can never unlink another user's link to the same shared `wallets` row).
 * Does NOT delete the underlying `wallets` row itself -- other users, or
 * a registered webhook, may still reference it.
 */
export async function unlinkWallet(db: Pool, userId: string, walletId: string): Promise<boolean> {
  const result = await db.query(`delete from user_wallets where user_id = $1 and wallet_id = $2`, [userId, walletId]);
  return (result.rowCount ?? 0) > 0;
}

/** Every distinct (wallet_id, chain, address) linked by *any* user -- what the daily-PnL worker's full cycle iterates over. */
export async function listAllLinkedWallets(db: Pool): Promise<{ walletId: string; chain: Chain; address: string }[]> {
  const result = await db.query<{ wallet_id: string; chain: Chain; address: string }>(
    `select distinct w.id as wallet_id, w.chain, w.address
     from user_wallets uw
     join wallets w on w.id = uw.wallet_id`,
  );
  return result.rows.map((r) => ({ walletId: r.wallet_id, chain: r.chain, address: r.address }));
}
