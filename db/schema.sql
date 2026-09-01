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

-- API keys — see src/plugins/apiKey.ts, currently a single shared secret
-- instead of rows here.
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  owner_email text not null,
  tier text not null check (tier in ('free', 'builder', 'growth', 'enterprise')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Registered PnL-threshold webhooks — see src/routes/webhooks.ts, currently
-- an in-memory Map instead of this table, and nothing delivers to `url` yet.
create table webhooks (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references wallets (id) on delete cascade,
  url text not null,
  threshold_pct numeric not null default 10,
  created_at timestamptz not null default now()
);
