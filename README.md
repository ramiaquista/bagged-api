# Bagged — API

Multi-chain memecoin PnL/portfolio API — Solana, BNB Chain, Robinhood Chain,
Ethereum. Node.js + TypeScript + Fastify.

## Getting started

```bash
npm install
cp .env.example .env
docker compose up -d   # local Postgres on 5432 (user/pass/db: bagged)
psql "$DATABASE_URL" -f db/schema.sql   # first run only, or after a schema change
npm run dev        # http://localhost:8080
```

`/waitlist` is backed by real Postgres (see "Persistence" below) — the dev
server and `npm test` both need a reachable database matching
`DATABASE_URL` in `.env` (defaults to the `docker-compose.yml` instance
above if unset).

Every route except `/health` and `POST /waitlist` requires an `x-api-key`
header. Three ways to authenticate:

- A **real per-customer key** (see "API keys" below) — issued via
  `npm run keys:create`, backed by the `api_keys` table.
- The **legacy shared secret**, `API_KEY_SECRET` — kept working
  deliberately for backward compatibility (see "API keys" below).
- In local dev only (with `ALLOW_DEV_KEY=true` from `.env.example`), the
  literal value `dev` (see `src/plugins/apiKey.ts`) — that flag must stay
  unset on Railway/production.

```bash
curl -H "x-api-key: dev" "http://localhost:8080/wallet/abc123/pnl?chain=solana"
```

## API keys

`src/plugins/apiKey.ts` now authenticates against real per-customer keys
(Item 5 in `NEXT_STEPS.md`), backed by the `api_keys` table in
`db/schema.sql` and the data-access layer in `src/db/apiKeys.ts`, instead of
just the single shared secret.

- **Tiers**: `free`, `builder`, `growth` — the three self-serve pricing
  tiers (see `src/lib/tiers.ts`). `enterprise` is also a legal `tier` value
  in the database (it predates this item) for manually negotiated deals
  outside the self-serve tiers, but has no fixed limit in
  `TIER_LIMITS`. **Judgment call:** the per-tier `monthlyRequestLimit`
  numbers in `src/lib/tiers.ts` are placeholders — the original product
  spec with the real negotiated numbers wasn't available in this worktree;
  see the comment on `TierLimits` for details. Only the *shape* is load
  bearing here; NEXT_STEPS.md Item 7 is what will actually enforce a limit.
- **Issuance/rotation**: no self-serve dashboard (explicitly out of scope
  per NEXT_STEPS.md) — an internal CLI instead:

  ```bash
  npm run keys:create -- --email owner@example.com --tier builder
  npm run keys:rotate -- --id <api_key_id>
  npm run keys:revoke -- --id <api_key_id>
  npm run keys:list   -- [--email owner@example.com]
  ```

  `create`/`rotate` print the plaintext key exactly once — only its sha256
  hash is ever stored (`api_keys.key_hash`), so it can't be recovered
  later.
- **Usage counters**: every request authenticated by a real per-customer key
  increments a per-key, per-minute counter in `api_key_usage`
  (`recordApiKeyUsage()` in `src/db/apiKeys.ts`), and stamps
  `api_keys.last_used_at`. This is bookkeeping only — no rate limit is
  enforced yet (`src/plugins/rateLimit.ts` is still a single global limit);
  the counters exist to give NEXT_STEPS.md Item 7 something real to read.
- **Backward compatibility (deliberate)**: the legacy shared
  `API_KEY_SECRET`, and the local-only `dev` bypass key, both still
  authenticate exactly as before — checked first, before touching
  Postgres at all — so existing Railway traffic and the existing test
  suite don't need a coordinated migration. Both resolve to an `internal`
  pseudo-tier (not a real stored tier — see `src/lib/tiers.ts`) and don't
  write usage counters (there's no `api_keys.id` to attribute usage to).
  Migrating Railway's real traffic onto issued keys and retiring this path
  is a deliberate follow-up, not part of this item.

## What's real vs. stubbed right now

This is a scaffold: the full API surface from the product spec is
implemented and testable end-to-end, but it currently serves **mock data**
rather than indexing real chains. Every stubbed piece says so in a comment
at the top of its file — the short version:

- `src/providers/{solana,evm}.ts` — return canned `WalletPnl`/`Position`
  data instead of calling Helius/Alchemy/Moralis/Jupiter.
- `src/pnl-engine/*` — the bonding-curve cost-basis, wash-trade filter, and
  rug-resolution functions are typed and wired for a real trade-history
  pipeline, but not implemented yet. Nothing calls into this module yet;
  the providers return pre-computed mock `WalletPnl` directly.
- `src/plugins/apiKey.ts` — **real**, backed by Postgres (see "API keys"
  above): per-customer keys, tiers, and usage counters via the `api_keys`
  table. The legacy shared `API_KEY_SECRET` and the `dev` bypass key
  (`ALLOW_DEV_KEY=true` only — never set that in Railway/production, see
  `.env.example`) still work too, deliberately, for backward compatibility.
- `src/routes/webhooks.ts` — registers webhooks in memory; nothing is ever
  delivered.
- `src/routes/waitlist.ts` — **real**, backed by Postgres (see
  "Persistence" below). It's the one route that's intentionally public (no
  `x-api-key`) since bagged-website's signup form calls it straight from the
  browser — see `src/plugins/apiKey.ts`. `GET /waitlist/count` and `GET
  /waitlist` (the full entry list) both require `x-api-key`.
- `db/schema.sql` — the Postgres schema. `waitlist` and `api_keys` (plus
  `api_key_usage`) are wired up (see below); `wallets`, `trades`,
  `positions`, `pnl_snapshots`, and `webhooks` are still just schema,
  waiting on the items in the project's `NEXT_STEPS.md` that use them.

## Persistence

`src/routes/waitlist.ts` was the first route wired to real Postgres, and
served as the template for `api_keys` (Item 5, see "API keys" above);
`webhooks` (Item 6 in `NEXT_STEPS.md`) is still pending.

- Client: [`pg`](https://node-postgres.com/) (`node-postgres`) — chosen over
  the `postgres` package for being the most widely used/battle-tested
  Postgres client for Node, with mature first-class TypeScript types
  (`@types/pg`).
- `src/db/pool.ts` builds a `Pool` from `config.DATABASE_URL`.
- `src/plugins/db.ts` is a Fastify plugin that decorates `app.db` with that
  pool and closes it in an `onClose` hook, so the pool's lifecycle always
  matches the app's (no leaked connections across `app.close()` in tests).
- `src/db/waitlist.ts` is the data-access layer: `insertWaitlistSignup`
  (atomic `ON CONFLICT (email) DO NOTHING`, so case-insensitive dedup can't
  race the way a check-then-set on the old in-memory `Map` could),
  `listWaitlistEntries`, `countWaitlistEntries`.
- The `waitlist` table itself was missing from `db/schema.sql` (the file
  only had `wallets`/`trades`/`positions`/`pnl_snapshots`/`api_keys`/
  `webhooks`) even though the README and route already described it as the
  intended target — added it as part of this work; see the comment above
  `create table waitlist` in `db/schema.sql` for details.

## Security

- **CORS** (`src/lib/cors.ts`) allows `https://bagged.life`,
  `https://www.bagged.life`, and Vercel preview deploys matching
  `https://bagged-website-*.vercel.app` (assumption — no `vercel.json` or
  team name was available to confirm the exact preview slug; update the
  pattern in `src/lib/cors.ts` if it doesn't match the real Vercel project).
  Set `CORS_ALLOWED_ORIGINS` (comma-separated exact origins) to allow more
  without a code change — e.g. a staging domain.
- **`ALLOW_DEV_KEY`** must stay unset (or `false`) everywhere except local
  dev — see "Getting started" above and `src/plugins/apiKey.ts`.
- **Error tracking** (`src/lib/sentry.ts`) is optional Sentry scaffolding.
  Set `SENTRY_DSN` to activate it; unset, it's a complete no-op (no init,
  no network calls, doesn't affect startup). No DSN is provisioned yet.

## API surface

| Method | Path | |
|---|---|---|
| GET | `/health` | no auth |
| GET | `/wallet/:address/pnl?chain=` | |
| GET | `/wallet/:address/positions?chain=` | |
| POST | `/wallets/batch` | body `{ wallets: [{address, chain}] }` |
| GET | `/portfolio/:userId` | rolls up all 4 chains (mock-linked wallets for now) |
| GET | `/leaderboard?chain=&window=&limit=` | |
| WS | `/wallet/:address/stream?chain=` | pushes a PnL read every 5s |
| POST | `/webhooks` | body `{ url, wallet, chain, threshold_pct }` |
| GET | `/webhooks` | |
| DELETE | `/webhooks/:id` | |
| POST | `/waitlist` | body `{ email, note? }` — no auth required |
| GET | `/waitlist/count` | auth required |
| GET | `/waitlist` | auth required — full entry list |

`chain` is one of `solana`, `bnb`, `robinhood`, `ethereum` everywhere.

## Scripts

```bash
npm run dev         # tsx watch, loads .env
npm run build        # tsc -> dist/
npm start             # run the built output
npm test               # vitest run
npm run typecheck       # tsc --noEmit
npm run lint              # eslint
npm run keys:create        # issue an API key -- see "API keys" above
npm run keys:rotate         # rotate an API key
npm run keys:revoke          # revoke an API key
npm run keys:list             # list API keys
```

## Structure

```
src/
  app.ts            # builds the Fastify instance (testable — see test/*.test.ts)
  index.ts           # boots app.ts and starts listening
  config.ts           # env var loading/validation (zod)
  plugins/              # apiKey (real per-key auth), db (pg pool), rateLimit
  routes/                # one file per route group
  schemas/                 # zod schemas shared by routes + tests
  providers/                 # ChainProvider interface + Solana/EVM stubs + registry
  pnl-engine/                  # cost-basis / wash-trade / rug-resolution skeleton
  db/                              # pg Pool + per-table data-access helpers (waitlist, apiKeys)
  lib/                            # errors, tiers, etc.
db/
  schema.sql                        # Postgres schema (waitlist + api_keys wired up; rest still pending)
scripts/
  manage-api-key.ts                   # internal CLI: create/rotate/revoke/list API keys
test/                                  # vitest, uses Fastify's inject() — no real server needed
```

## Next steps toward real chain data

1. ~~Pick a Postgres access layer and turn `db/schema.sql` into real
   migrations.~~ Done for `waitlist` — see "Persistence" above.
2. Implement `SolanaProvider` against Helius (RPC + webhooks/LaserStream)
   and direct pump.fun program reads for pre-graduation pricing.
3. Implement `EvmProvider` against Alchemy or Moralis for BNB
   Chain/Robinhood Chain/Ethereum, plus four.meme (and whatever ships on
   Robinhood Chain) contract reads.
4. Wire `src/pnl-engine` into the providers: raw fills -> `filterWashTrades`
   -> `computeCostBasis` -> `resolveRugs` -> `WalletPnl`, replacing the
   mock-data shortcut.
5. ~~Move `src/plugins/apiKey.ts` onto the `api_keys` table with real
   per-tier keys.~~ Done — see "API keys" above. Real per-tier *rate
   limiting* (enforcing `TIER_LIMITS`) is still pending, on top of the
   usage counters this item added.
6. Build the webhook delivery worker (diff PnL snapshots, POST to
   registered URLs, retry).
