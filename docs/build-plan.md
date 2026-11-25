# Build plan

Target: Dev3pack, Nov 27–29, 2026. Main Solana track, devnet.

## What the rules mean for us

From the [official FAQ](https://hack.dev3pack.xyz/faq), read Nov 25, 2026:

- Building early is allowed for Solana projects. Disclose before/during work in the README.
- AI-generated code is allowed, but you must understand it and be able to explain it.
- **Open source is mandatory.** The repo is private today.
- **Video under 3 minutes, strict.** A real product demo, at a public link.
- Submission: project info (optional contract address), images, video, repo, live link, team. Solo is fine; maximum 4.
- Signals judged: eligibility, product clarity, real-world impact, demo quality, deployment, repo quality, **Solana/SDK depth**. Top 100 get code inspection and live demo verification.
- Hard deadline Sunday Nov 29; exact UTC hour is in the dashboard.

So a deployed link matters, and a treasury that just transfers tokens is thin on Solana depth. G8 (escrow) addresses that, once the basic flow works.

## Scope

| Tier | Contents |
|---|---|
| **Must** | Mints, API, web send → unwrap → claim on devnet, deployed link, video |
| **Should** | Group chip-in, escrow program, conversation view |
| **If Mac** | iMessage extension |
| **Could** | Price feed, voice note |
| **Cut** | Real money, accounts, Base, embedded wallets, notifications, expiry and refunds (the treasury funds gifts, so nobody is owed one until escrow) |

## Architecture

```
web (Next.js)  ──┐                       ┌── Postgres (Supabase)
                 ├─▶ /api/* (same app) ──┤
iOS extension  ──┘   treasury signer     └── Solana devnet, Token-2022
```

```
packages/shared/   zod schemas, types, money math, fixtures
packages/chain/    Solana client, mint setup, transfers
supabase/          SQL migrations
web/               Next.js UI and route handlers
programs/          escrow (G8)
ios/               host app and extension (G9)
```

pnpm workspace. Vitest for tests; PGlite runs the real migrations without Docker; `solana-test-validator` covers chain tests; Playwright covers the browser.

## Tokens

Five Token-2022 mints: `tNVDA tAAPL tSPY tTSLA tCOST` (Costco is in the group mockup). 8 decimals, multiplier 1.0, metadata. Setup is idempotent.

```
shares = usdCents / priceCents
raw    = floor(shares / multiplier × 10^8)      stored, transferred
shown  = raw / 10^8 × effective multiplier
```

A scheduled multiplier applies only from its effective timestamp (inclusive). Round down, in integer (bigint) arithmetic: `raw`, `shown` (as 10⁻⁸ units) and current value in cents all floor. Only the display string rounds to the nearest 4th decimal, and the UI shows it as "≈". Reference case: $10.00 at $229.52 and multiplier 1 gives raw 4356918 and shows 0.0436; the same raw at multiplier 1.002 shows 0.0437. Wrapping under 1.002 gives raw 4348222, which still shows 0.0436. Code: `packages/shared/src/money.ts`. A script changes the multiplier to demonstrate a dividend.

**Two-version trap:** `@solana/spl-token` 0.4.15 has the scaled-UI helpers but needs web3.js v1; npm's latest is v3.

## Data

```sql
create table gifts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('single','group')),
  status text not null check (status in ('funding','wrapped','opened','claiming','claimed')),
  sender_name text not null,
  recipient_name text not null,
  ticker text not null,
  usd_cents integer not null check (usd_cents > 0),
  price_cents integer,                 -- set when wrapped
  token_raw numeric(39,0),             -- set when wrapped
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
create table contributions (
  id uuid primary key default gen_random_uuid(),
  gift_id uuid not null references gifts(id),
  idempotency_key uuid not null,
  contributor_name text not null,
  usd_cents integer not null check (usd_cents > 0),
  created_at timestamptz not null default now(),
  unique (gift_id, idempotency_key)
);
create table prices (
  ticker text primary key,
  usd_cents integer not null,
  source text not null,
  updated_at timestamptz not null default now()
);
```

RLS on, no public policies: only the server reads or writes.

## API

JSON. Errors: `{ error: { code, message } }`.

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/gifts` | — | `{senderName, recipientName, ticker, usdCents, note?, opensAt?}` → `{id, claimToken}`. Amount is 1000, 2500 or 5000 |
| `GET /api/gifts/:id` | — | Public state. Before opening, a single gift's ticker, amount and note are **absent**, not just hidden |
| `POST /api/gifts/:id/open` | token | `wrapped → opened`. 425 `too_early` before `opensAt` (server clock) |
| `POST /api/gifts/:id/swap` | token | `{ticker}`, only while `opened`; same USD value |
| `POST /api/gifts/:id/claim` | token | `{wallet}`. 200 claimed, 202 pending |
| `POST /api/groups` | — | `{organizerName, recipientName, ticker, goalCents, opensAt?, note?}` → `{id, claimToken}`. Goal at most 10000 |
| `POST /api/groups/:id/contributions` | — | `{name, usdCents, idempotencyKey}`. Atomic; rejects amounts above the remainder; reaching the goal moves to `wrapped` |

`GET` also returns the current value with `{priceSource, priceUpdatedAt}` after opening, and group totals plus contributor names. "Token" is `Authorization: Bearer <claimToken>`. Rate-limit creation, since it draws down the treasury.

### Contract details

The zod schemas in `packages/shared/src/schemas.ts` are the source of truth; this summarizes them. All objects are strict: unknown keys fail validation.

- **Tickers** in the API are the underlying symbols `NVDA AAPL SPY TSLA COST`; `TOKEN_SYMBOLS` maps them to `tNVDA`… Names are 1–40 characters, notes 1–280, `opensAt` is ISO 8601 with offset.
- **Public gift** (`GET`, and the body of `open` and `swap`): `{id, kind, status, senderName, recipientName, opensAt, createdAt}` plus, by state:
  - single `wrapped`: nothing else. A single gift is never `funding`.
  - group `funding`/`wrapped`: `ticker, goalCents, raisedCents, contributors` (names only).
  - `opened` and later: `usdCents, note, tokenRaw, openedAt, value{priceCents, priceSource, priceUpdatedAt, multiplier, shares, valueCents}`, plus `ticker` for singles.
  - `claiming`: `recipientWallet, claimSignature|null`. `claimed`: `recipientWallet, claimSignature, claimedAt`.
- **Claim response:** 200 `{status:"claimed", signature, gift}`; 202 `{status:"pending", signature|null, gift}`.
- **Contribution response:** `{contribution{id, name, usdCents, createdAt}, gift}`. A retried idempotency key returns the original contribution.
- **Error codes → HTTP:** `bad_request`, `validation_failed`, `invalid_wallet` 400; `unauthorized` 401; `forbidden` 403; `not_found` 404; `invalid_state`, `exceeds_remaining` 409; `too_early` 425; `rate_limited` 429; `internal` 500; `chain_unavailable` 503.

### Claim must never pay twice

1. Compare-and-swap `opened → claiming`, storing the wallet. One caller wins.
2. Build and sign: idempotent ATA creation plus `transferChecked`.
3. Store the signature and last valid block height **before** sending.
4. Send and confirm, then set `claimed`.
5. On retry while `claiming`: look up the stored signature. Confirmed → `claimed`. Unknown and not past the height → 202. Past the height, after a finalized history lookup shows no landing → one caller may replace the signature by compare-and-swap. The wallet stays fixed.

### Who can claim

- **Single:** the link carries the token, `/g/:id#t=…`. The fragment stays out of server logs and preview crawlers.
- **Group:** the group link has **no token**, or anyone in the chat could take the gift. The organizer gets the token once and sends the recipient a private link.

## Clients

**Web:** `/` compose, `/g/:id` gift, `/w` wallet. Polls state. Open Graph image shows a wrapped card and never the contents. The wallet is a non-extractable Ed25519 WebCrypto key in IndexedDB; clearing browser data loses it, which is acceptable on devnet and stated in the UI.

**Conversation view:** `/demo` shows sender and recipient threads side by side using the real components and API, labeled "Prototype thread". Link previews are frozen, so without iOS this is how the live card is demonstrated.

**iOS:** Messages exposes participants only as UUIDs, so the host app asks for a display name. `MSMessage.url` carries the gift id; its query carries the token for single gifts.

## Schedule

| When | Work |
|---|---|
| Wed 25 – Thu 26 | Accounts. G0, then G1 and G2 in parallel |
| Fri 27 | G3, G4, first deploy. **Noon: decide on the Mac** |
| Sat 28 | G5 done by noon = 1:1 gate. Then G6 and G8 in parallel, or G9 with a Mac |
| Sat night | Feature freeze on anything not merged; record a backup video |
| Sun 29 | G10, final video, submit hours before the cutoff |

If the 1:1 gate slips past Saturday noon, cut G8 first, then G6.

## Needed from the owner

- [ ] Dev3pack: confirm you're accepted and read the exact deadline
- [ ] Supabase project: URL and service-role key in `.env`
- [ ] Vercel login and project
- [ ] Devnet SOL for the treasury (faucets rate-limit, so do it early)
- [ ] Choose a license
- [ ] Make the repo public before submitting
- [ ] Mac decision by Friday noon
- [ ] ElevenLabs key, only if doing voice

## Risks

| Risk | Response |
|---|---|
| Double claim, stuck claim | Protocol above; G3 tests it |
| Public devnet RPC is flaky | Configurable RPC; claim is retryable; backup video |
| Market price barely moves: Thanksgiving is Nov 26, and US markets close for the weekend | Show the price's source and age; use the multiplier change as the visible on-chain event |
| Unproven iMessage behavior: live-bubble buttons and sending from transcript style are undocumented | Device or Simulator spike first. Default: bubble tap opens the expanded view, which does the action |
| `MSSession` update may move the message rather than change it in place | Let the live bubble refetch state; check it in the spike |
| Thin Solana depth | G8 |
| Agents break each other's work | G0 freezes the contracts; path ownership per goal |

## Demo, 90 seconds

1. First shares are awkward to gift; crypto links bounce you out of the chat.
2. Send $10 of NVDA. A wrapped card appears.
3. Unwrap, claim, show the devnet transaction.
4. The same card changes to Opened with its value; bump the multiplier and show the share count rise.
5. Three friends chip in toward Costco for Grandma.
6. State plainly: devnet test tokens, and what's next.

## Stretch decision: escrow

Gift PDA vault holding the tokens, enforcing open time and single claim on-chain, with a hash-locked claim. Design point to settle in G8: the claim must bind the secret to the recipient's address so an observed transaction can't be front-run (use a claim keypair's signature over the claim, not a bare preimage).
