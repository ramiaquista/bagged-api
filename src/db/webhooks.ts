import type { Pool } from "pg";
import type { Chain } from "../schemas/chain.js";
import type { RegisterWebhookRequest, WebhookRecord } from "../schemas/webhook.js";
import { findOrCreateWallet } from "./wallets.js";

interface WebhookRow {
  id: string;
  url: string;
  threshold_pct: string; // numeric columns come back as strings from `pg`
  created_at: Date;
  chain: Chain;
  address: string;
}

function toRecord(row: WebhookRow): WebhookRecord {
  return {
    id: row.id,
    url: row.url,
    wallet: row.address,
    chain: row.chain,
    threshold_pct: Number(row.threshold_pct),
    created_at: row.created_at.toISOString(),
  };
}

const WEBHOOK_JOIN_SELECT = `
  select w.id, w.url, w.threshold_pct, w.created_at, wa.chain, wa.address
  from webhooks w
  join wallets wa on wa.id = w.wallet_id
`;

/**
 * Registers a webhook, backed by the `webhooks` table (db/schema.sql) --
 * mirrors src/db/waitlist.ts's DAL pattern. `webhooks.wallet_id` is a
 * foreign key, but the route's public contract takes `{ wallet, chain }`
 * (an address + chain pair, not an internal id), so this resolves/creates
 * the `wallets` row first via findOrCreateWallet.
 */
export async function registerWebhook(db: Pool, input: RegisterWebhookRequest): Promise<WebhookRecord> {
  const wallet = await findOrCreateWallet(db, input.chain, input.wallet);

  const result = await db.query<{ id: string; url: string; threshold_pct: string; created_at: Date }>(
    `insert into webhooks (wallet_id, url, threshold_pct)
     values ($1, $2, $3)
     returning id, url, threshold_pct, created_at`,
    [wallet.id, input.url, input.threshold_pct],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insert into webhooks returned no row");
  }

  return {
    id: row.id,
    url: row.url,
    wallet: input.wallet,
    chain: input.chain,
    threshold_pct: Number(row.threshold_pct),
    created_at: row.created_at.toISOString(),
  };
}

export async function listWebhooks(db: Pool): Promise<WebhookRecord[]> {
  const result = await db.query<WebhookRow>(`${WEBHOOK_JOIN_SELECT} order by w.created_at asc`);
  return result.rows.map(toRecord);
}

/** Idempotent: returns `false` if no webhook with that id exists. */
export async function deleteWebhook(db: Pool, id: string): Promise<boolean> {
  const result = await db.query(`delete from webhooks where id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export interface WebhookDeliveryTarget {
  id: string;
  url: string;
  thresholdPct: number;
  walletId: string;
  chain: Chain;
  address: string;
}

/**
 * Every registered webhook, including the internal `wallet_id` the delivery
 * worker (src/worker/webhookWorker.ts) needs to read/write `pnl_snapshots`
 * -- unlike listWebhooks() (the public route response shape), which
 * deliberately doesn't expose internal ids.
 */
export async function listWebhooksForDelivery(db: Pool): Promise<WebhookDeliveryTarget[]> {
  const result = await db.query<WebhookRow & { wallet_id: string }>(
    `select w.id, w.wallet_id, w.url, w.threshold_pct, w.created_at, wa.chain, wa.address
     from webhooks w
     join wallets wa on wa.id = w.wallet_id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    url: row.url,
    thresholdPct: Number(row.threshold_pct),
    walletId: row.wallet_id,
    chain: row.chain,
    address: row.address,
  }));
}
