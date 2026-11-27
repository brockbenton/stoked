# Escrow program (G8)

A small Anchor program that locks one gift's tokens in its own vault until the recipient claims them or the gift expires. Code: [`programs/escrow`](../programs/escrow), TypeScript client: [`packages/chain/escrow`](../packages/chain/escrow). Devnet and local validator only.

The API uses it only when `STOKED_ESCROW=1`. The flag is off by default.

## Framework

Anchor 1.2.2 (`anchor-lang`, `anchor-spl`), the latest stable release on crates.io on 2026-11-27 (2.0 is a release candidate). Built with `cargo build-sbf` 4.1.0 (platform tools v1.54, rustc 1.89, which is Anchor's minimum). Program tests use LiteSVM, which can set the cluster clock. The TypeScript client encodes instructions itself on `@solana/web3.js` v1, so it adds no dependency.

References, read 2026-11-27: [changelog](https://www.anchor-lang.com/docs/updates/changelog), [1.0.0 release notes](https://www.anchor-lang.com/docs/updates/release-notes/1-0-0), [token extensions](https://www.anchor-lang.com/docs/tokens/extensions). The release notes recommend Solana 3.1.10 and don't mention 4.x; the build and tests here ran on 4.1.

## Accounts

Both are program-derived addresses (PDAs), one pair per gift.

| Account | Seeds | Contents |
|---|---|---|
| `Gift` | `"gift"`, sender, gift_id | The terms and outcome (below). Kept after claim or refund |
| Vault | `"vault"`, gift | Token-2022 token account for the mint, owned by the `Gift` PDA. Closed on claim or refund |

`Gift`, 179 bytes including Anchor's 8-byte discriminator, little-endian:

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `sender` | pubkey | Locked the tokens; gets refunds and the vault's rent |
| 40 | `gift_id` | [u8; 16] | Random nonce chosen by the sender |
| 56 | `claim_key` | pubkey | Only this key can authorize a claim |
| 88 | `mint` | pubkey | The locked token |
| 120 | `amount` | u64 | Raw units locked at creation |
| 128 | `open_at` | i64 | Claim allowed from this cluster time (unix seconds) |
| 136 | `expires_at` | i64 | Claim allowed before this time, refund from it |
| 144 | `status` | u8 | 0 open, 1 claimed, 2 refunded |
| 145 | `recipient` | pubkey | Who claimed; zero until then |
| 177 | `bump` | u8 | |
| 178 | `vault_bump` | u8 | |

The sender is part of the seeds, so nobody else can create the account for a sender's `gift_id` first. The account outlives the claim, so the same address can't be created twice and the outcome stays readable.

## Instructions

```
        create_gift            claim: open_at <= now < expires_at
sender ─────────────▶ Open ───────────────────────────────────▶ Claimed
                       │
                       └──── refund: now >= expires_at ───────▶ Refunded
```

| Instruction | Signers | Does |
|---|---|---|
| `create_gift(gift_id, claim_key, amount, open_at, expires_at)` | sender | Creates both PDAs and transfers `amount` raw units from the sender's token account into the vault |
| `claim()` | claim key (plus any fee payer) | Marks the gift claimed, moves the whole vault to the recipient's associated token account, closes the vault |
| `refund()` | sender | Marks the gift refunded, moves the whole vault to the sender's associated token account, closes the vault |

Checks:

- **create:** token program is Token-2022; the mint is supported (below); `amount > 0`; `expires_at > open_at`; `expires_at > now`.
- **claim:** signer equals `gift.claim_key`; status is open; `open_at <= now < expires_at`; sender, mint and vault match the gift; the destination is the associated token account of the `recipient` account named in the same instruction.
- **refund:** signer equals `gift.sender`; status is open; `now >= expires_at`; mint and vault match; the destination is the sender's associated token account.

Claim and refund windows don't overlap, so at any moment at most one of them can succeed. A claim that lands at or after `expires_at` fails even if nobody has refunded yet. Claim and refund move the vault's full balance, not `amount`: otherwise anyone could block both by sending the vault one extra unit, because a token account with a balance can't be closed.

## How the claim key binds program, gift and recipient

The claim key is an ordinary transaction signer. A Solana signature covers the whole message: the program being called, every account (so the gift and the recipient), and the instruction data. Changing any of them invalidates the signature, and the program refuses a claim signed by any key other than the one stored in the gift. An observed transaction therefore can't be redirected to another wallet or replayed against another gift. No secret goes on chain, so there is nothing to front-run.

The alternative, a detached signature checked through the Ed25519 precompile and instruction introspection, lets one party sign and another submit later. Nothing here needs that (the server builds and signs the whole transaction), and introspection is more code to get wrong.

## Token-2022

The app's mints have three extensions: `MetadataPointer`, `TokenMetadata` and `ScaledUiAmount`, and no freeze authority.

- `create_gift` accepts only mints whose extensions are a subset of those three and that have **no freeze authority**. Anything else is refused, including transfer fees (the vault would receive less than `amount`), transfer hooks, permanent delegate (could empty the vault), pausable, default-frozen accounts, and a mint close authority.
- None of the three requires an account extension, so the vault is a plain 165-byte Token-2022 account.
- Transfers use `transfer_checked` with raw units. A multiplier change alters only the displayed amount; the locked raw amount is unchanged.
- This is stricter than real tokenized stocks, which can carry issuer controls such as freeze or permanent delegate. Supporting them means trusting the issuer with the vault, and is out of scope.

## How the app uses it

### Sender, relayer, claim key

Clients still never sign. The **on-chain sender is the server's treasury**: it signs `create_gift`, pays fees and rent, and is the only key that can refund. The person who sends a gift in the app has no wallet and gets nothing back on chain.

The claim key is derived, never stored:

```
claim keypair = Ed25519 from HKDF-SHA256(ikm = claim token, salt = gift's database id,
                                         info = "stoked:escrow:claim-key:v1")
```

The link format (`/g/:id#t=…`) is unchanged. The database holds `sha256(token)`, from which the claim key can't be derived. The server computes the key at creation (to publish its public half) and again at claim time, from the token in the request.

The on-chain `gift_id` is random and unrelated to the database id. The database stores the `Gift` address in `gifts.escrow_account`; null means an ordinary treasury-transfer gift.

### Timing

- `open_at` = `opensAt` rounded up to a whole second, or 0 when the gift opens immediately.
- `expires_at` = 30 days after the later of creation and `opensAt`.
- `opensAt` more than 365 days ahead is refused, because the tokens are locked from creation.

### Flag behaviour

| | Flag off (default) | Flag on |
|---|---|---|
| Create | Database row only | Row, then `create_gift`; the link is returned only after it confirms, otherwise 503 |
| Open | Server clock | Same, and the chain enforces the time again at claim |
| Swap | Allowed while opened | **Refused (409 `invalid_state`)** for escrow gifts: the mint and amount are locked |
| Claim | Treasury `transferChecked` | Program `claim`, signed by the claim key, fees paid by the treasury |
| Expiry | None | After 30 days: claim answers 410 `expired`, and the treasury can refund |

The mode is fixed per gift at creation. Turning the flag off stops new escrow gifts; existing ones still claim through the program, and old treasury gifts still swap and claim as before. The opened gift is marked `swappable: false`, and the web app hides the swap button.

Swapping stays off because the program has no way to take tokens back before expiry. Adding one would give the sender an early exit from the vault.

### Configuration

| Variable | Meaning |
|---|---|
| `ESCROW_PROGRAM_ID` | The deployed program. Set it to enable the escrow code at all, and **keep it set while any escrow gift exists** |
| `STOKED_ESCROW` | `1` makes new gifts escrow gifts. Requires `ESCROW_PROGRAM_ID` |

Order: merge and let production deploy this code, apply `supabase/migrations/20261127000000_escrow.sql`, deploy the program, then set the variables.

The server reads whole rows, so it runs on a database without the migration and still recognises an escrow gift when `ESCROW_PROGRAM_ID` is unset: it refuses to claim or swap it. **Code from before escrow does not.** It would pay an escrow gift from the treasury while the vault stays claimable by whoever has the link. Every deployment that shares the database (Preview and Production do today) must therefore run this code before the first escrow gift is created, and production must never be rolled back past it while escrow gifts exist.

## Never pay twice

The five-step claim protocol ([build plan](build-plan.md#claim-must-never-pay-twice)) is unchanged. The program adds a second, independent guard: a gift's vault can be emptied once.

Before binding a wallet, and before building any claim transaction, the server reads the `Gift` account and the cluster clock.

| What it finds | Response |
|---|---|
| Open, inside the window | Build, store the signature, send (steps 2 to 4) |
| Open, cluster time before `open_at` | 425 `too_early`; retry |
| Open, at or past `expires_at`, or refunded | 410 `expired` |
| Claimed to the bound wallet | Find the successful claim transaction, store it, mark claimed |
| Claimed to another wallet | 409 `invalid_state` |
| No account, or the RPC fails | 503 `chain_unavailable`; nothing changes |

| Crash or retry case | Outcome |
|---|---|
| After signing, before storing | Nothing was sent; the retry builds again |
| After storing, before sending | Pending until the blockhash expires, then replaced once |
| After sending, before confirming | The retry finds it confirmed |
| Stored transaction failed or expired | Read the gift as above, then replace by compare-and-swap |
| A replaced transaction lands after all | The vault is already empty, so only one can ever succeed; the gift account says who was paid |
| Concurrent retries | One stores its signature; the others are discarded unsent |

Creation: build and sign `create_gift`, insert the row with the escrow address, send, wait for confirmation. If it hasn't confirmed 15 seconds after the request arrived (the web client gives up at 20), the request fails and the claim token is never returned. If that transaction lands later, the tokens sit in a vault nobody can claim until the treasury refunds it after expiry. Nothing is paid out twice.

## Threat model

Assets: the locked tokens, and the surprise (what a wrapped gift contains).

### What the program guarantees

For a gift that exists on chain, assuming the program isn't upgraded:

- Tokens leave the vault only to the wallet named in a transaction the claim key signed, or to the sender after expiry.
- Not before `open_at`, and only once.
- An observer can't redirect, replay or front-run a claim.

### Who can do what

| Attacker | Can | Cannot |
|---|---|---|
| Network observer | See gifts, claims and amounts | Redirect or replay a claim |
| Holder of the link | Claim to any wallet from `open_at`, including by calling the program directly and skipping the app | Claim early or twice |
| Leaked database only | Read gifts and notes | Claim: only token hashes are stored |
| Leaked treasury key only | Spend unlocked treasury funds; refund gifts after expiry | Take locked tokens before expiry |
| Leaked treasury key and database | As above | Same limit: the claim token is in neither |
| Database write access | Already enough to redirect treasury-transfer gifts | Release a vault without the token. It can still clear `escrow_account` and have the treasury pay a second time |
| **Malicious or compromised running server** | **Keep claim tokens it generates or receives, and claim to any wallet from `open_at`; substitute the recipient when signing a claim; never create or never refund** | Claim before `open_at`, or take from a vault whose token it didn't retain |
| **Program upgrade authority** | **Replace the program and take every vault** | |

The two bold rows are the real trust assumptions. The server generates every claim token and signs every claim, so the escrow doesn't make the app trustless. It narrows what a stolen treasury key or database can do, and lets anyone check on chain that a gift is funded, when it opens and who received it. Client-side token generation and signing would remove the server rows; v1 doesn't do that.

The upgrade authority is set by whoever deploys the program. This work doesn't change one. **It must not be the treasury key**: if it were, a leaked treasury key could replace the program and the "leaked treasury key" rows above would be false. A deployment that should be immutable needs the owner to revoke the authority, which can't be undone.

### Other limits

- **The surprise is public on chain.** The app hides a wrapped gift's ticker and amount; the chain doesn't. The on-chain id isn't derived from the link, but the treasury's history lists every gift, and creation times can be matched.
- **Spam costs the treasury SOL.** Each creation pays rent before anyone opens the gift: 0.00214 SOL for the gift account and 0.00204 SOL for the vault (measured with `solana rent` on a local validator; a claim to a new wallet adds a token account). The vault's rent returns on claim or refund; the gift account's rent is never reclaimed (there is no close instruction). The existing creation rate limits apply.
- **Creation is slower** and can fail after the tokens were sent (a timed-out confirmation or request). The sender retries and the first gift's tokens stay locked until refunded. A host that cuts requests off sooner than about 15 seconds would make this more likely.
- **A refund is manual.** Nothing runs on a timer: `pnpm --filter @stoked/chain escrow:refund` refunds expired gifts. There is no expired status: the card stays as it was (the sender of a half-claimed gift still sees it as on its way), and the recipient is told it expired on trying to claim.
- **A claim made outside the app** to a different wallet than the app bound leaves the database row in `claiming`.
- **Cluster time** can drift from wall-clock time. A claim right at `open_at` may be told to retry.
- **`findClaimSignature` reads the latest 100 transactions** that mention a gift account. Flooding one with unrelated transactions could keep a claim made outside the stored transaction at 202; no funds are affected.
- **The devnet smoke test** (`web/e2e-smoke`) expects the claim transaction to debit the treasury, so it fails against a deployment with the flag on until it's taught about vaults.
- **Not audited.**

## Tests

```sh
pnpm test:escrow   # build the program, program tests, client and API on solana-test-validator
```

Needs the Solana CLI and Rust. CI has no Rust or Solana toolchain, so it runs only the TypeScript unit tests: the wire format ([`escrow-unit.test.ts`](../packages/chain/test/escrow-unit.test.ts)) and the API against a fake chain ([`escrow.test.ts`](../web/test/server/escrow.test.ts)). The program itself is not checked in CI.

Program tests are in [`programs/escrow/tests/escrow.rs`](../programs/escrow/tests/escrow.rs):

| Required case | Test |
|---|---|
| Create and claim | `create_locks_the_amount_in_the_vault`, `create_then_claim_releases_the_exact_amount_and_closes_the_vault` |
| Early claim | `early_claim_fails_and_succeeds_at_the_open_time` |
| Double claim | `double_claim_fails`, `status_alone_refuses_a_second_claim_or_refund_even_with_a_funded_vault` |
| Wrong claim key | `wrong_claim_key_fails`, `another_gifts_claim_key_cannot_claim`, `claim_without_the_claim_key_signature_fails` |
| Substituted recipient | `substituted_recipient_in_a_signed_claim_fails_signature_verification`, `substituted_recipient_token_account_fails`, `recipient_token_must_be_the_associated_account` |
| Substituted mint | `substituted_mint_fails` |
| Substituted vault | `substituted_vault_fails` |
| Substituted token program | `substituted_token_program_fails` |
| Replay across gifts | `claim_key_signature_does_not_replay_across_gifts` |
| Refund before expiry | `refund_before_expiry_fails` |
| Refund after expiry | `refund_after_expiry_returns_the_tokens_to_the_sender`, `only_the_sender_can_refund_and_only_to_itself` |
| Claim versus refund ordering | `claim_wins_before_expiry_and_refund_then_fails`, `claim_after_expiry_fails_and_refund_then_blocks_claim` |
| Raw amount after a multiplier change | `multiplier_change_leaves_the_raw_amount_unchanged` |

On 2026-11-27, removing each of these checks in turn (open time, claim expiry, refund expiry, status, claim key, mint, recipient token account, mint allowlist, full-balance release) made at least one of these tests fail.

## Deploying to devnet

Needs the owner's approval. Not done yet.

1. **Program keypair.** The program ID `eXVAv3pDTpMfobKopghfV6BQui7WKx61qcoacRvbtdB` belongs to a keypair at `programs/escrow/target/deploy/stoked_escrow-keypair.json` in the worktree that built G8. It's gitignored: back it up before removing that worktree, and copy it to the same path in the checkout you deploy from **before** building (otherwise the build creates a different one). If it's lost, generate a new one and update `declare_id!` and `ESCROW_PROGRAM_ID` in `packages/chain/escrow/program.ts`.
2. **Deployer keypair**, separate from the treasury and never on the server. It becomes the upgrade authority. Fund it on devnet: the program is 238 KB, about 1.66 SOL of rent at local-validator rates, plus fees.
3. Run `pnpm test:escrow`, then from the repo root:

   ```sh
   solana program deploy programs/escrow/target/deploy/stoked_escrow.so \
     --program-id programs/escrow/target/deploy/stoked_escrow-keypair.json \
     --keypair <deployer.json> --upgrade-authority <deployer.json> --url devnet
   solana program show eXVAv3pDTpMfobKopghfV6BQui7WKx61qcoacRvbtdB --url devnet
   ```

4. In the Supabase SQL editor run `supabase/migrations/20261127000000_escrow.sql`.
5. Set `ESCROW_PROGRAM_ID` and `STOKED_ESCROW=1` for a Vercel preview, deploy it, and create, claim and check one gift on the explorer.
6. Refunds, when gifts expire: `ESCROW_PROGRAM_ID=… pnpm --filter @stoked/chain escrow:refund` with the devnet `.env`.

To roll back, unset `STOKED_ESCROW` only, and keep `ESCROW_PROGRAM_ID`.
