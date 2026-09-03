-- Bagged — intended Postgres schema.
--
-- STATUS: not wired up yet. The running API currently serves mock data from
-- src/providers/mockData.ts and never opens a database connection. This
-- file documents the data model the PnL engine and routes are designed
-- around, so persistence can be added without redesigning the API surface.
--
-- Suggested next step: pick an access layer (postgres.js, node-postgres,
-- Prisma/Drizzle) and a migration tool, then turn this into real migrations.

create extension if not exists "pgcrypto";

create type chain as enum ('solana', 'bnb', 'robinhood', 'ethereum');

-- Waitlist signups from the public marketing site form (POST /waitlist,
-- intentionally unauthenticated -- see src/plugins/apiKey.ts). Not present
-- in the original draft of this file even though src/routes/waitlist.ts and
-- the README already described it as the intended persistence target --
-- added here as part of wiring up real storage.
--
-- `email` is stored already-lowercased (src/schemas/waitlist.ts normalizes
-- it before it ever reaches the database), so a plain unique constraint is
-- enough to enforce case-insensitive dedup without a functional index.
create table waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  note text,
  created_at timestamptz not null default now()
);

-- One row per wallet Bagged has ever indexed.
create table wallets (
  id uuid primary key default gen_random_uuid(),
  chain chain not null,
  address text not null,
  created_at timestamptz not null default now(),
  unique (chain, address)
);

-- Links a Bagged customer's user_id to the wallets that make up their
-- portfolio — what GET /portfolio/{user_id} rolls up.
create table user_wallets (
  user_id text not null,
  wallet_id uuid not null references wallets (id) on delete cascade,
  linked_at timestamptz not null default now(),
  primary key (user_id, wallet_id)
);

-- Raw fills, as ingested from Helius / Alchemy / Moralis. This is the input
-- to src/pnl-engine — wash-trade filtering, cost-basis, and rug resolution
-- all operate on rows here.
create table trades (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references wallets (id) on delete cascade,
  tx_signature text not null,
  token_mint_or_address text not null,
  side text not null check (side in ('buy', 'sell')),
  quantity numeric not null,
  price_usd numeric not null,
  pre_graduation boolean not null default false,
  is_wash_trade boolean not null default false,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (wallet_id, tx_signature, token_mint_or_address, side)
);
create index trades_wallet_token_idx on trades (wallet_id, token_mint_or_address);

-- Current computed position per wallet/token — the output of the PnL
-- engine's cost-basis step, kept up to date as new trades land.
create table positions (
  wallet_id uuid not null references wallets (id) on delete cascade,
  token_mint_or_address text not null,
  quantity numeric not null,
  cost_basis_usd numeric not null,
  is_rugged boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (wallet_id, token_mint_or_address)
);

-- Point-in-time PnL rollups, the source for both GET /wallet/{address}/pnl
-- (latest row) and GET /leaderboard (ranked over a window).
create table pnl_snapshots (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references wallets (id) on delete cascade,
  realized_pnl_usd numeric not null,
  unrealized_pnl_usd numeric not null,
  positions_open integer not null,
  wash_trades_excluded integer not null default 0,
  rugs_resolved integer not null default 0,
  snapshot_at timestamptz not null default now()
);
create index pnl_snapshots_wallet_time_idx on pnl_snapshots (wallet_id, snapshot_at desc);

-- Self-serve partner (developer/customer) accounts backing bagged-website's
-- `/b2b-dashboard` -- see src/routes/partner.ts and src/lib/partnerAuth.ts.
-- Distinct from the single-operator admin login (src/lib/adminAuth.ts,
-- env-configured, no table): any number of partners sign themselves up
-- here with an email + password, unlike the internal /admin dashboard's one
-- hardcoded operator account.
--
-- `password_hash` uses the same scrypt KDF as ADMIN_PASSWORD_HASH (see
-- src/lib/partnerAuth.ts) -- a human-chosen password, unlike an issued API
-- key, is low-entropy and needs a slow salted hash. `email` is stored
-- already-lowercased (src/schemas/partner.ts normalizes it), same
-- convention as `waitlist.email` above.
create table partners (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  company_name text,
  created_at timestamptz not null default now()
);

-- API keys — see src/plugins/apiKey.ts and src/db/apiKeys.ts (Item 5, real
-- per-customer keys). Only a salted hash of the plaintext key is ever
-- stored (sha256 -- see hashApiKey() in src/db/apiKeys.ts); the plaintext is
-- shown once at issuance/rotation time (src/scripts/manage-api-key.ts) and
-- never persisted. `tier` covers the three self-serve pricing tiers
-- (free/builder/growth -- see src/lib/tiers.ts) plus 'enterprise' for
-- manually negotiated deals outside the self-serve tiers; this table
-- predates this item (it was already here, unused) so the check constraint
-- is left as found rather than narrowed to just the three self-serve tiers.
-- `last_used_at` is updated on every authenticated request that resolves to
-- a row here (not the legacy shared-secret/dev-key paths, which have no row
-- to update) -- convenient for `manage-api-key.ts list` without joining
-- against api_key_usage.
--
-- `partner_id` is null for every key issued by hand from /admin (the
-- pre-existing path, src/routes/admin.ts) and set for a key that traces
-- back to a self-serve /b2b-dashboard account (src/routes/partner.ts) --
-- what lets a partner's dashboard scope `GET /partner/api-keys` etc. to
-- only their own keys, and what a partner's rotate/revoke calls check
-- ownership against. `on delete cascade` matches the wallets/webhooks
-- pattern elsewhere in this file; there's no "delete my account" flow yet,
-- so this is inert for now, not exercised.
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  owner_email text not null,
  tier text not null check (tier in ('free', 'builder', 'growth', 'enterprise')),
  partner_id uuid references partners (id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
create index api_keys_partner_idx on api_keys (partner_id);

-- Per-key request counters, bucketed into fixed-size time windows so a
-- future usage-based rate limiter (NEXT_STEPS.md Item 7) can enforce
-- per-tier limits by reading counts here instead of re-deriving them from
-- raw request logs. Incremented once per authenticated request that
-- resolves to a real api_keys row (src/plugins/apiKey.ts) via an atomic
-- upsert (see recordApiKeyUsage() in src/db/apiKeys.ts).
--
-- JUDGMENT CALL: one-minute buckets, matching the granularity of the
-- existing global limiter in src/plugins/rateLimit.ts. Item 7 can either
-- rate-limit directly off these buckets or roll them up into a monthly
-- total against src/lib/tiers.ts's TIER_LIMITS -- this table doesn't commit
-- to either, just to "counts exist, per key, per time bucket."
create table api_key_usage (
  api_key_id uuid not null references api_keys (id) on delete cascade,
  window_start timestamptz not null,
  request_count bigint not null default 0,
  primary key (api_key_id, window_start)
);
create index api_key_usage_key_idx on api_key_usage (api_key_id, window_start desc);

-- Per-request log entries, one row per authenticated request from a real
-- `api_keys` row (never the legacy shared-secret/dev-key paths, matching
-- `api_key_usage` above -- see recordRequestLog() in src/db/requestLog.ts,
-- written from an onResponse hook in src/plugins/requestLog.ts). Backs the
-- "Logs" page of bagged-website's `/b2b-dashboard` -- a partner debugging
-- their own integration needs to see recent calls (method, path, status),
-- not just an aggregate count like `api_key_usage`'s minute buckets.
--
-- JUDGMENT CALL: this is a v1 recent-activity log, not a durable audit
-- trail -- there's no retention/pruning job here (a reasonable follow-up
-- once real traffic volume makes that necessary), and query call sites cap
-- how many rows they read back (see listRequestLogs()) rather than this
-- table capping how many exist.
create table api_request_log (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid not null references api_keys (id) on delete cascade,
  method text not null,
  path text not null,
  status_code integer not null,
  created_at timestamptz not null default now()
);
create index api_request_log_key_idx on api_request_log (api_key_id, created_at desc);

-- Registered PnL-threshold webhooks -- see src/routes/webhooks.ts (register/
-- list/delete, backed by src/db/webhooks.ts) and src/worker/webhookWorker.ts
-- (the background delivery worker, NEXT_STEPS.md Item 6), which diffs each
-- wallet's current PnL against its latest `pnl_snapshots` row and POSTs to
-- `url` when `threshold_pct` is crossed.
create table webhooks (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references wallets (id) on delete cascade,
  url text not null,
  threshold_pct numeric not null default 10,
  created_at timestamptz not null default now()
);
