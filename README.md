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
header. In local dev (with `ALLOW_DEV_KEY=true` from `.env.example`), the
literal value `dev` is also accepted (see `src/plugins/apiKey.ts`) — that
flag must stay unset on Railway/production, where only `API_KEY_SECRET`
works.

```bash
curl -H "x-api-key: dev" "http://localhost:8080/wallet/abc123/pnl?chain=solana"
```

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
- `src/plugins/apiKey.ts` — one shared secret, not per-customer keys/tiers.
  The `dev` bypass key only works when `ALLOW_DEV_KEY=true` — never set
  that in Railway/production (see `.env.example`).
- `src/routes/webhooks.ts` — registers webhooks in memory; nothing is ever
  delivered.
- `src/routes/waitlist.ts` — **real**, backed by Postgres (see
  "Persistence" below). It's the one route that's intentionally public (no
  `x-api-key`) since bagged-website's signup form calls it straight from the
  browser — see `src/plugins/apiKey.ts`. `GET /waitlist/count` and `GET
  /waitlist` (the full entry list) both require `x-api-key`.
- `db/schema.sql` — the Postgres schema. `waitlist` is wired up (see
  below); `wallets`, `trades`, `positions`, `pnl_snapshots`, `api_keys`, and
  `webhooks` are still just schema, waiting on the items in the project's
  `NEXT_STEPS.md` that use them.

## Persistence

`src/routes/waitlist.ts` is the first route wired to real Postgres, as a
template for the tables that come next (`api_keys` for Item 5, `webhooks`
for Item 6 in `NEXT_STEPS.md`).

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
```

## Structure

```
src/
  app.ts            # builds the Fastify instance (testable — see test/*.test.ts)
  index.ts           # boots app.ts and starts listening
  config.ts           # env var loading/validation (zod)
  plugins/              # apiKey (auth stub), db (pg pool), rateLimit
  routes/                # one file per route group
  schemas/                 # zod schemas shared by routes + tests
  providers/                 # ChainProvider interface + Solana/EVM stubs + registry
  pnl-engine/                  # cost-basis / wash-trade / rug-resolution skeleton
  db/                              # pg Pool + per-table data-access helpers
  lib/                            # errors, etc.
db/
  schema.sql                        # Postgres schema (waitlist is wired up; rest still pending)
test/                                # vitest, uses Fastify's inject() — no real server needed
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
5. Move `src/plugins/apiKey.ts` onto the `api_keys` table with real
   per-tier rate limiting.
6. Build the webhook delivery worker (diff PnL snapshots, POST to
   registered URLs, retry).
