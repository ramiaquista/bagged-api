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

- `src/providers/solana.ts` — returns canned `WalletPnl`/`Position` data
  instead of calling Helius/Jupiter.
- `src/providers/evm.ts` — real for BNB Chain, Robinhood Chain, and
  Ethereum: ingests real fills via Alchemy and feeds them through
  `src/pnl-engine`. See "EVM provider (BNB / Robinhood Chain / Ethereum)"
  below for what's real vs. still gated on the pnl-engine stubs.
- `src/pnl-engine/*` — the bonding-curve cost-basis, wash-trade filter, and
  rug-resolution functions are typed and wired for a real trade-history
  pipeline, but not implemented yet (being implemented on a parallel branch
  for the Solana provider). `EvmProvider` already calls into these stubs
  end-to-end (see `src/providers/evm.ts`'s `TODO(merge)` comments) — until
  the real math lands there, real EVM wallets fetch genuine on-chain fills
  but report zeroed-out PnL and no open positions, because
  `computeCostBasis` unconditionally returns zero. `SolanaProvider` still
  returns pre-computed mock `WalletPnl` directly and doesn't call into this
  module at all yet.
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
`computeCostBasis` → `resolveRugs`, all still stubs — see `TODO(merge)`
comments in `evm.ts`) → `WalletPnl` / `Position[]`.

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
wallet on both chains — expected, not a bug: `computeCostBasis` is still
the pnl-engine stub and unconditionally returns zero holdings regardless of
input, so real fills don't yet turn into nonzero PnL or open positions.
**Full hand-validation against known real-money outcomes (this item's
literal acceptance bar) is blocked on the parallel pnl-engine
implementation landing** — the ingestion/reconciliation layer this item
owns is real and tested; the arithmetic on top of it isn't implemented yet
by design (see item-2-solana-provider branch).

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
  providers/                 # ChainProvider interface + Solana (mock) / EVM (real) + registry
    alchemy/                     # Alchemy HTTP client (JSON-RPC + Enhanced APIs + Prices API)
    launchpads/                   # per-chain bonding-curve resolvers (four.meme, hood.fun, ...)
    evmTradeBuilder.ts               # pairs raw Alchemy transfers into priced Trade[]
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
3. ~~Implement `EvmProvider` against Alchemy or Moralis~~ — done (Alchemy).
   Confirm the real hood.fun contract address(es) on Robinhood Chain (see
   "EVM provider" above) once available.
4. Implement `src/pnl-engine`'s stubs for real (`computeCostBasis`,
   `filterWashTrades`, `resolveRugs` — in progress on
   `item-2-solana-provider`). `EvmProvider` already calls into these; once
   the real math lands, real EVM `WalletPnl`/`Position[]` numbers should
   start reflecting it with no further provider-side changes needed.
5. Move `src/plugins/apiKey.ts` onto the `api_keys` table with real
   per-tier rate limiting.
6. Build the webhook delivery worker (diff PnL snapshots, POST to
   registered URLs, retry).
