# Architecture and contracts

How Stoked is built, and the data and API contracts the code follows. Devnet or a local validator only.

## Architecture

```
web (Next.js) ──▶ /api/* (same app) ──┬── Postgres (Supabase)
                  treasury signer     └── Solana devnet, Token-2022
```

```
packages/shared/   zod schemas, types, money math, fixtures
packages/chain/    Solana client, mint setup, transfers, escrow client
programs/escrow/   Anchor escrow program
supabase/          SQL migrations
web/               Next.js UI and route handlers
```

pnpm workspace. Vitest for tests; PGlite runs the real migrations without Docker; `solana-test-validator` covers chain tests; Playwright covers the browser.

## Tokens

Five Token-2022 mints: `tNVDA tAAPL tSPY tTSLA tCOST`. These symbols are the tickers everywhere: API, database and UI. 8 decimals, multiplier 1.0, metadata. Setup is idempotent.

```
shares = usdCents / priceCents
raw    = floor(shares / multiplier × 10^8)      stored, transferred
shown  = raw / 10^8 × effective multiplier
```

A scheduled multiplier applies only from its effective timestamp (inclusive). Integer (bigint) arithmetic: `raw` and `shown` (as 10⁻⁸ units) round down, so a transfer never exceeds what was paid for. Displayed amounts round to the nearest step: the share string to the 4th decimal (shown as "≈") and the current value to the cent. Reference case: $10.00 at $229.52 and multiplier 1 gives raw 4356918 and shows 0.0436; the same raw at multiplier 1.002 shows 0.0437. Wrapping under 1.002 gives raw 4348222, which still shows 0.0436. Code: `packages/shared/src/money.ts`. A script changes the multiplier to demonstrate a dividend.

**Two-version trap:** `@solana/spl-token` 0.4.15 has the scaled-UI helpers but needs web3.js v1; npm's latest is v3.

## Data

```sql
create table gifts (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('wrapped','opened','claiming','claimed')),
  sender_name text not null,
  recipient_name text not null,
  ticker text not null,                -- token symbol, e.g. 'tNVDA'
  usd_cents integer not null check (usd_cents > 0),
  price_cents integer not null,        -- price used to size the gift
  token_raw numeric(39,0) not null,    -- raw units reserved for the gift
  note text,
  opens_at timestamptz,
  claim_token_hash text not null,      -- sha256; the plain token is returned once
  recipient_wallet text,
  claim_signature text,
  claim_last_valid_height bigint,
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  claimed_at timestamptz
);

create table prices (
  ticker text primary key,             -- token symbol, e.g. 'tNVDA'
  usd_cents integer not null,
  source text not null,
  updated_at timestamptz not null default now()
);

alter table gifts enable row level security;
alter table prices enable row level security;
```

A gift is sized when it's created (the treasury funds it), so `price_cents` and `token_raw` are required and it starts `wrapped`. Swap updates `ticker`, `price_cents` and `token_raw`. RLS on, no public policies: only the server reads or writes. A second migration grants `service_role` select, insert and update, because Supabase may not grant new tables automatically.

A third migration adds `escrow_account text`: the on-chain account holding an escrow gift's tokens, null for a gift the treasury transfers at claim time. It's set at creation and never changes. The Supabase store reads it wherever the column exists, whatever the server's settings, and writes it only for escrow gifts, so a database without this migration works while escrow is off.

## API

JSON. Errors: `{ error: { code, message } }`.

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/gifts` | — | `{senderName, recipientName, ticker, usdCents, note?, opensAt?}` → `{id, claimToken}`. Amount is 1000, 2500 or 5000 |
| `GET /api/gifts/:id` | — | Public state. Before opening, the gift's ticker, amount and note are **absent**, not just hidden |
| `POST /api/gifts/:id/open` | token | `wrapped → opened`. 425 `too_early` before `opensAt` (server clock) |
| `POST /api/gifts/:id/swap` | token | `{ticker}`, only while `opened`; same USD value |
| `POST /api/gifts/:id/claim` | token | `{wallet}`. 200 claimed, 202 pending |
| `GET /api/wallets/:address` | — | Test token balances of a wallet: `{wallet, holdings: [{ticker, tokenRaw, multiplier, shares, sharesExact}]}`. Public chain data; only non-zero holdings; rate-limited (60 per minute per client IP) |

With escrow on, routes and response shapes are the same; behaviour differs as described under [Escrow](#escrow).

`GET` also returns the current value with `{priceSource, priceUpdatedAt}` after opening. "Token" is `Authorization: Bearer <claimToken>`. Creation is rate-limited, since it draws down the treasury.

Prices come from the `prices` table. For a ticker with no row, the server uses a built-in demo price and reports the source as `Demo price (not live)`. Nothing refreshes the table.

### Contract details

The zod schemas in `packages/shared/src/schemas.ts` are the source of truth; this summarizes them. All objects are strict: unknown keys fail validation.

- **Tickers** are the token symbols `tNVDA tAAPL tSPY tTSLA tCOST`; `UNDERLYING` maps each to its stock (`NVDA`, "Nvidia") for display. Names are 1–40 characters, notes 1–280, `opensAt` is ISO 8601 with offset.
- **Public gift** (`GET`, and the body of `open` and `swap`): `{id, status, senderName, recipientName, opensAt, createdAt}` plus, by state:
  - `wrapped`: nothing else.
  - `opened` and later: `ticker, usdCents, note, tokenRaw, openedAt, value{priceCents, priceSource, priceUpdatedAt, multiplier, shares, valueCents}`.
  - `claiming`: `recipientWallet, claimSignature|null`. `claimed`: `recipientWallet, claimSignature, claimedAt`.
- **Claim response:** 200 `{status:"claimed", signature, gift}`; 202 `{status:"pending", signature|null, gift}`.
- **Error codes → HTTP:** `bad_request`, `validation_failed`, `invalid_wallet` 400; `unauthorized` 401; `forbidden` 403; `not_found` 404; `invalid_state` 409; `expired` 410 (escrow gifts only); `too_early` 425; `rate_limited` 429; `internal` 500; `chain_unavailable` 503.

### Claim must never pay twice

1. Compare-and-swap `opened → claiming`, storing the wallet. One caller wins.
2. Build and sign: idempotent ATA creation plus `transferChecked`.
3. Store the signature and last valid block height **before** sending.
4. Send and confirm, then set `claimed`.
5. On retry while `claiming`: look up the stored signature. Confirmed → `claimed`. Unknown and not past the height → 202. Past the height, after a finalized history lookup shows no landing → one caller may replace the signature by compare-and-swap. A transaction that landed with an error (seen at `confirmed` or later) moved nothing and is replaced the same way. The wallet stays fixed, and a claim naming a different wallet gets 409 `invalid_state`.

Server code: `web/lib/server` (service with injected `GiftStore`, `ChainAdapter`, clock and rate limiter; Supabase store in production, SQL store on PGlite in tests). Creation is rate-limited twice: in memory per client IP (5 per minute, and 100 per minute across all clients, both per instance; the IP comes from platform-set headers first), and durably by counting rows in `gifts` (200 per hour across all instances), since each claim to a new wallet also spends treasury SOL on rent. Request bodies are strict (unknown keys → 400 `validation_failed`). RPC failures return 503 `chain_unavailable` with a generic message; details go to the server log only.

A pending claim moves forward only when the claim request is sent again, so the web client repeats it (same wallet) while the gift is `claiming`, including after a reload. `GET` never advances a claim.

### Escrow

Off by default. `ESCROW_PROGRAM_ID` enables the code; `STOKED_ESCROW=1` makes new gifts lock their tokens in the [escrow program](escrow.md) at creation. A gift keeps the mode it was created with. For an escrow gift:

- **Create:** the link is returned only once the locking transaction confirms (otherwise 503 `chain_unavailable`, within 15 seconds); `opensAt` more than 365 days ahead is 400 `validation_failed` (the web form refuses such dates for every gift); the gift expires 30 days after the later of creation and `opensAt`.
- **Swap:** 409 `invalid_state`. The opened gift carries `swappable: false` (absent otherwise) and the web app hides the button.
- **Claim:** the same five steps, with the program's `claim` (signed by a key derived from the claim token) in place of the treasury transfer. The server reads the gift on chain before binding a wallet and before building: not yet open by cluster time → 425 `too_early`; expired or refunded → 410 `expired`; claimed to another wallet → 409 `invalid_state`; already claimed to the bound wallet → record that transaction and answer claimed.
- **Expiry:** there is no expired status; claiming answers 410 and the gift screen says it expired. `pnpm --filter @stoked/chain escrow:refund` returns expired gifts to the treasury.

### Running locally

`STOKED_LOCAL_DB=1` swaps Supabase for an in-process PGlite database running the real migration (lost on restart). The server refuses it unless `SOLANA_RPC_URL` is a loopback address, and always on Vercel.

| Command | What it runs |
|---|---|
| `pnpm test:e2e` | Both browser suites below |
| `pnpm --filter @stoked/web test:ui` | UI states on fixtures (`NEXT_PUBLIC_STOKED_CLIENT=fixture`, set by the Playwright config) |
| `pnpm --filter @stoked/web test:flow` | Real API, local database and `solana-test-validator`: send, claim, refresh mid-claim, link preview, token and key leaks |
| `pnpm test:escrow` | Builds the escrow program, then program tests, the TypeScript client and the API on `solana-test-validator`. Needs the Solana CLI; not run in CI |

### Who can claim

The link carries the token, `/g/:id#t=…`. The fragment stays out of server logs and preview crawlers.

## Web client

`/` compose, `/g/:id` gift, `/w` wallet. After wrapping, the main button opens the system share sheet; without one, Copy is the main button. The gift page polls every 3 seconds while the tab is visible (15 once claimed). The Open Graph image shows a wrapped card and never the contents. The wallet is a non-extractable Ed25519 WebCrypto key in IndexedDB; clearing browser data loses it, which is acceptable on devnet and stated on the wallet screen.
