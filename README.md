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
  see the comment on `TierLimits` for details. NEXT_STEPS.md Item 7 (see
  "Rate limiting" below) now enforces against these placeholders — replace
  them with the real spec numbers once available and the enforced limits
  follow automatically.
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
  `api_keys.last_used_at`. This remains the durable, cross-restart source of
  truth for a key's usage (billing/support tooling, `manage-api-key.ts
  list`), separate from the in-memory rate limiter below.
- **Rate limiting (Item 7, `src/plugins/rateLimit.ts`)**: real per-customer
  keys on a self-serve tier (free/builder/growth) are now rate-limited
  against an hourly cap derived from that tier's `monthlyRequestLimit` in
  `src/lib/tiers.ts` (`hourlyRequestLimit()`: `ceil(monthlyRequestLimit /
  720)` — 720 = hours in a 30-day month). An hourly window, not per-minute,
  is deliberate: real usage is bursty, and a per-minute slice of the
  monthly average (e.g. Free ≈ 1 req/min) would throttle legitimate
  clients well before they used their real monthly budget; an hourly
  window still bounds abuse while giving bursty traffic headroom. This
  does not enforce the monthly figure itself as a hard cutoff — see the
  comment above `hourlyRequestLimit` in `src/lib/tiers.ts` for the full
  reasoning and the exact per-tier numbers.
  Enforcement uses `@fastify/rate-limit`'s own in-memory store (fast,
  per-request, no extra DB round trip) keyed per API key; the Postgres
  counters above remain the persisted source of truth. That's a deliberate
  split, not a second parallel usage-tracking system — see the doc comment
  on `rateLimit.ts`'s default export for the full design rationale,
  including the tradeoff (resets on redeploy, doesn't sync across multiple
  instances — fine for the current single-instance deployment; swap in
  `@fastify/rate-limit`'s Redis store first if that changes).
  The legacy shared secret, the `dev` bypass key, and `enterprise` keys
  (which deliberately have no fixed number in `TIER_LIMITS`) all keep the
  pre-existing global default instead (100 req/min, keyed by IP for the
  legacy paths) — unchanged from before this item, so existing Railway
  traffic isn't newly throttled.
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

- `src/providers/solana.ts` — returns canned `WalletPnl`/`Position` data
  instead of calling Helius/Jupiter.
- `src/providers/evm.ts` — real for BNB Chain, Robinhood Chain, and
  Ethereum: ingests real fills via Alchemy and feeds them through
  `src/pnl-engine`. See "EVM provider (BNB / Robinhood Chain / Ethereum)"
  below for what's real vs. still gated on the pnl-engine stubs.
- `src/pnl-engine/*` — **real**: weighted-average cost basis, wash-trade
  filtering (adjacent opposite-side same-token fills within a short window),
  and rug resolution (force-closes a position to a loss once price craters
  relative to its historical peak). Both `SolanaProvider` and `EvmProvider`
  call into this end-to-end now — real fills in, real `WalletPnl`/
  `Position[]` out. See "EVM provider" below for the per-chain ingestion
  status feeding into it.
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

## EVM provider (BNB Chain / Robinhood Chain / Ethereum)

`src/providers/evm.ts` is one `EvmProvider` class parameterized by chain
(`bnb` | `robinhood` | `ethereum`) — not three separate provider classes.

**Provider choice: Alchemy, not Moralis.** The spec left this undecided;
Alchemy is what's actually provisioned (`ALCHEMY_API_KEY`), and it covers
all three chains here out of the box, including Robinhood Chain (live on
Alchemy the same week the chain itself launched, 2026-07-01). Revisit only
if Alchemy's coverage/pricing/limits stop working — the rest of the
provider only depends on the small `AlchemyClient` interface in
`src/providers/alchemy/client.ts`, so swapping backends later is contained.

**Pipeline:** Alchemy `alchemy_getAssetTransfers` (native + ERC-20 fills,
both directions) → `buildTradesFromTransfers` (`src/providers/evmTradeBuilder.ts`,
pairs a native leg with an ERC-20 leg in the same tx into a priced buy/sell,
tags bonding-curve fills) → `src/pnl-engine` (`filterWashTrades` →
`computeCostBasis` → `resolveRugs`, now real — implemented alongside the
Solana provider, see "What's real vs. stubbed right now" above) →
`WalletPnl` / `Position[]`.

**Chain-specific bonding-curve reconciliation** lives in
`src/providers/launchpads/`, one `LaunchpadResolver` per chain:

| Chain | Launchpad | Status |
|---|---|---|
| BNB | four.meme | Real TokenManager2 proxy address wired in (`fourMeme.ts`), cross-referenced against public four.meme indexing docs. Re-verify on BscScan before production use. |
| Robinhood Chain | hood.fun | Pipeline is real end-to-end, but no confirmed on-chain contract address is wired in yet — hood.fun's site/whitepaper don't publish one, and the Robinhood Chain block explorer sat behind a bot-check during this pass. See the `KNOWN GAP` comment in `hoodFun.ts`. This is a follow-up research item, not a pnl-engine merge dependency. |
| Ethereum | none | Deliberate research conclusion, not an oversight: no dominant pump.fun/four.meme-style bonding-curve launchpad exists on Ethereum mainnet as of 2026-09 (gas costs push that activity to L2s/other chains). All Ethereum fills are treated as ordinary AMM-priced trades. |

Priority order shipped per the spec (Robinhood Chain first, then BNB, then
Ethereum): Robinhood Chain's resolver and network wiring were built and
validated first; BNB reuses the same pipeline with a real four.meme
address; Ethereum reuses it with no launchpad-specific logic (see above).

**Graceful-degradation policy**, so real-EVM behavior can't break the
existing mocked API surface:

- Address isn't a well-formed `0x` address, or `ALCHEMY_API_KEY` isn't
  configured → falls back to the pre-existing mock data (this is what keeps
  the original Vitest suite, which calls routes with placeholder addresses
  like `"some-address"`, passing unchanged).
- Address is well-formed and Alchemy is configured, but the upstream call
  itself fails → throws a `502 upstream_provider_error`, rather than
  silently returning fake-but-plausible PnL. Hit this for real during hand
  validation: BNB Chain isn't enabled on the currently-provisioned Alchemy
  app (a per-app dashboard toggle at dashboard.alchemy.com, not a code
  issue) — `eth-mainnet` and `robinhood-mainnet` both work.

**Hand validation done during this implementation** (no automated test
depends on live network or the real key — see `test/providers/`, which
inject a fake `AlchemyClient`): ran the real pipeline against
`0xd8da6bf26964af9d7eed9e03e53415d37aa96045` (vitalik.eth, a real,
high-activity, public wallet) on Ethereum and Robinhood Chain. Confirmed
real transfers are fetched (10,000 on Ethereum — enough to hit the
per-direction page cap documented in `alchemy/client.ts`; 116 on Robinhood
Chain, which only launched 2026-07-01), correctly paired into priced
buy/sell trades where a same-tx native+ERC-20 leg exists, and correctly
skipped otherwise (token-for-token swaps, mints/airdrops with no native
leg). End-to-end `WalletPnl`/`Position[]` numbers were 0/empty for this
wallet on both chains at the time of this hand validation — expected, not a
bug: `computeCostBasis` was still the pnl-engine stub at that point (it has
since been implemented for real — see "What's real vs. stubbed right now"
above). **Re-running full hand-validation against known real-money outcomes
against the now-real pnl-engine is a worthwhile follow-up** — the ingestion/
reconciliation layer this item owns was validated against real transfer
data, but not yet against real nonzero PnL output end-to-end.

**Known v1 scope limits** (not merge-blocked, just not yet done):
- Only simple wallet↔native↔token swap legs are priced; multi-leg router
  transactions and direct token-for-token swaps are skipped rather than
  guessed at.
- Current spot price only (Alchemy Prices API) for both trade pricing and
  position valuation — no historical/at-trade-time pricing yet.
- Wallet history is capped at ~10k transfers per direction (see
  `MAX_PAGES_PER_DIRECTION` in `alchemy/client.ts`) — enough for a v1 pull,
  but a very high-activity wallet's earliest history could be truncated.
- hood.fun's contract address(es) aren't confirmed yet (see table above).

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
  plugins/              # apiKey (real per-key auth), db (pg pool), rateLimit (real per-tier limits)
  routes/                # one file per route group
  schemas/                 # zod schemas shared by routes + tests
  providers/                 # ChainProvider interface + Solana (mock) / EVM (real) + registry
    alchemy/                     # Alchemy HTTP client (JSON-RPC + Enhanced APIs + Prices API)
    launchpads/                   # per-chain bonding-curve resolvers (four.meme, hood.fun, ...)
    evmTradeBuilder.ts               # pairs raw Alchemy transfers into priced Trade[]
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
3. ~~Implement `EvmProvider` against Alchemy or Moralis~~ — done (Alchemy).
   Confirm the real hood.fun contract address(es) on Robinhood Chain (see
   "EVM provider" above) once available.
4. ~~Implement `src/pnl-engine`'s stubs for real.~~ Done — both
   `SolanaProvider` and `EvmProvider` now produce real `WalletPnl`/
   `Position[]` output. Worth a fresh hand-validation pass on real EVM
   wallets now that the arithmetic is live end-to-end (see "EVM provider"
   above).
5. ~~Move `src/plugins/apiKey.ts` onto the `api_keys` table with real
   per-tier keys.~~ Done — see "API keys" above.
6. ~~Enforce real per-tier rate limits (`TIER_LIMITS`).~~ Done — see "API
   keys" above and `src/plugins/rateLimit.ts`.
7. Build the webhook delivery worker (diff PnL snapshots, POST to
   registered URLs, retry).
