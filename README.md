# Bagged — API

Multi-chain memecoin PnL/portfolio API — Solana, BNB Chain, Robinhood Chain,
Ethereum. Node.js + TypeScript + Fastify.

## Getting started

```bash
npm install
cp .env.example .env
npm run dev        # http://localhost:8080
```

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
- `src/routes/waitlist.ts` — signups are kept in an in-memory `Map`, so a
  redeploy or restart drops them. It's the one route that's intentionally
  public (no `x-api-key`) since bagged-website's signup form calls it
  straight from the browser — see `src/plugins/apiKey.ts`.
- `db/schema.sql` — the intended Postgres schema; nothing in the running
  API opens a database connection yet. `docker-compose.yml` spins up a local
  Postgres if/when that's the next step.

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
  plugins/              # apiKey (auth stub), rateLimit
  routes/                # one file per route group
  schemas/                 # zod schemas shared by routes + tests
  providers/                 # ChainProvider interface + Solana/EVM stubs + registry
  pnl-engine/                  # cost-basis / wash-trade / rug-resolution skeleton
  lib/                            # errors, etc.
db/
  schema.sql                        # intended Postgres schema (not wired up)
test/                                # vitest, uses Fastify's inject() — no real server needed
```

## Next steps toward real chain data

1. Pick a Postgres access layer and turn `db/schema.sql` into real
   migrations.
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
