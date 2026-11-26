# Agent goals

Each block is a Claude Code [`/goal`](https://code.claude.com/docs/en/goal) condition. After every turn a small model judges the condition **from the transcript only**; it can't run commands. So each goal names checks whose output the agent must show.

## Running them

1. Merge the goal's dependencies into `main`.
2. Start a session in its own worktree: `claude --worktree g1-chain`
3. Use auto mode for unattended work; `/goal` doesn't change permissions.
4. Paste the block. One goal per session. `/goal` shows status; `/goal clear` stops.
5. G5 needs `.env`, which worktrees don't contain: run it from the main checkout on its own branch.
6. Review the diff and merge yourself. Run `/code-review` on G3 and G8 in particular.

| Goal | Needs | Owns | Where |
|---|---|---|---|
| G0 Scaffold and contracts | — | root, `packages/shared`, `supabase`, stubs | Linux |
| G1 Chain | G0 | `packages/chain` | Linux |
| G2 Gift UI | G0 | `web` UI, not `web/app/api` | Linux |
| G3 API and claim | G0, G1 | `web/app/api`, `web/lib/server` | Linux |
| G4 Wire up and browser test | G2, G3 | `web` | Linux |
| G5 Devnet and deploy | G4, owner accounts | config, docs | Linux |
| **1:1 gate** | **G5 passes** | | |
| ~~G6 Chip-in~~ | deferred | — | — |
| G7 Conversation view and price feed | G4 | `web/app/demo`, price job | Linux |
| G8 Escrow | gate | `programs`, `packages/chain/escrow` | Linux |
| G9 iMessage | G3, Mac | `ios` | Mac |
| G10 Submission | all kept work | docs, polish | Linux |

G1 and G2 are parallel. G6 is deferred (see below); G7 can start after G4.

Only the owner can: create accounts, provide keys, merge, deploy to production, choose a license, make the repo public, record and submit.

## G0: Scaffold and contracts

```
/goal Read CLAUDE.md and docs/build-plan.md. Build the pnpm workspace: packages/shared, packages/chain (stub), web (Next.js App Router, TypeScript strict), and supabase/migrations with the planned schema and RLS on. packages/shared exports zod schemas for every API request, response and error in the plan; money and scaled-UI math; and fixture gifts for every status. Add GitHub Actions CI running the same checks. Done when the transcript shows: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all exit 0; tests apply the real migration in PGlite; tests cover $10.00 at $229.52 showing 0.0436 shares, multiplier 1.002, rounding down, a scheduled multiplier before and after its timestamp, and that the public schema for a wrapped gift rejects ticker, amount and note; and `git status` is clean with work committed on branch g0-scaffold. Constraints: no feature UI, no real secrets, no Solana calls, no files under notes/. Stop after 30 turns and report what remains.
```

## G1: Chain package

```
/goal Read CLAUDE.md and docs/build-plan.md. Implement packages/chain: an idempotent script creating the five Token-2022 mints with Scaled UI Amount (multiplier 1.0, 8 decimals) and metadata and minting supply to the treasury; a multiplier-update script; effective-multiplier and balance reads; and separate functions to build-and-sign a claim transfer (idempotent ATA creation plus transferChecked), send it, and look up its status, so a caller can store the signature before sending. Done when the transcript shows `pnpm --filter chain test:validator` exit 0 against solana-test-validator, proving: five mints carry the extension; rerunning setup creates none; a claim works for a wallet with no ATA; after a multiplier change the raw balance is identical and the shown balance changes; sending the same signed transaction twice transfers once; and a cluster guard, checked by genesis hash, refuses mainnet. Also show `pnpm lint`, `pnpm typecheck` and `pnpm test` exit 0 and work committed on branch g1-chain. Constraints: web3.js v1; change only packages/chain and the lockfile; never print a secret key. Stop after 30 turns and report what remains.
```

## G2: Gift UI on fixtures

```
/goal Read CLAUDE.md, docs/design.md and look at every PNG in mockups/png. Build the web UI in web/ on packages/shared fixtures behind a typed client interface: compose (01), wrapped card (02), closed (03a), unwrap animation, reveal (03b), claimed card (04), and the 1:1 states listed under "States the mockups don't show". Use the copy overrides in docs/design.md. Done when the transcript shows: Playwright screenshots at 390x844 of each screen and state saved under web/test-results, each opened and compared against its mockup with differences fixed or listed; Playwright tests exit 0 covering keyboard use, accessible names, 44px targets, reduced motion and no horizontal scroll at 320px; `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` exit 0; and work committed on branch g2-ui. Constraints: don't touch web/app/api or packages/shared; don't build chip-in or voice; don't recreate Apple's Messages chrome. Stop after 35 turns and report what remains.
```

## G3: API and claim safety

```
/goal Read CLAUDE.md and docs/build-plan.md. Implement the 1:1 API routes exactly as specified, with injected database and chain adapters, rate-limited creation, and the five-step claim protocol. Done when the transcript shows `pnpm test` exit 0 with named tests for: every status transition and illegal transition; a wrapped gift's response containing no ticker, amount or note; only the token hash stored; wrong and missing tokens; too_early using the server clock; swap keeping USD value and refused after claim; invalid wallet; 20 concurrent claims producing exactly one transfer; crash after signing but before send; crash after send but before confirm; a retry with a different wallet not redirecting funds; an expired transaction replaced once under concurrent retries; and a confirmed transaction never replaced. Also show an integration test on solana-test-validator that creates, opens and claims a gift and checks the recipient balance, plus `pnpm lint`, `pnpm typecheck`, `pnpm build` exit 0, a search of the client bundle finding no server secrets, and work committed on branch g3-api. Constraints: change only web/app/api, web/lib/server, tests and the lockfile; if a contract is wrong, update docs/build-plan.md and packages/shared in the same commit and say so. Stop after 40 turns and report what remains.
```

## G4: Wire up end to end

```
/goal Read CLAUDE.md and docs/build-plan.md. Connect the web UI to the real API: compose, share link with the token in the fragment, unwrap, swap, claim, wallet page, polling, and a non-extractable WebCrypto Ed25519 wallet in IndexedDB. Add an Open Graph image that reveals nothing about the gift. Done when the transcript shows `pnpm test:e2e` exit 0 using two isolated Playwright contexts against a local validator and database: sender creates; recipient opens the link, unwraps, swaps and claims; the on-chain balance matches the UI; the sender's page shows claimed without reload; a second claim is refused; a refresh mid-claim recovers. Tests must also assert that the token appears in no page request URL or server log and the private key is never sent. Show `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` exit 0 and work committed on branch g4-e2e. Constraints: no mocked API or chain in the e2e test; don't weaken G2 or G3 tests. Stop after 35 turns and report what remains.
```

## G5: Devnet and deploy

Owner first: `.env` filled, treasury funded, Vercel linked.

```
/goal Read CLAUDE.md and docs/build-plan.md. Get the 1:1 flow working on Solana devnet from a Vercel preview deployment. Run mint setup, apply migrations to the configured Supabase project, seed prices with an honest source label, set preview environment variables without printing values, and deploy a preview. Done when the transcript shows a Playwright smoke run against the preview URL creating, unwrapping and claiming a gift; the confirmed devnet signature looked up by RPC with the expected mint, recipient and raw amount; confirmation that the genesis hash is devnet; RLS checked by an anonymous read returning no rows or a denial; a secret scan of git history finding nothing; and docs/devnet.md listing mint addresses, explorer links and setup steps, committed on branch g5-devnet. Constraints: preview only, no production deploy; before any remote write, list existing tables and stop if unrelated data is present; if an account, key or SOL is missing, name it and stop. Stop after 25 turns and report what remains.
```

## G6: Group chip-in (deferred)

Deferred: the hackathon wants significant work built inside the Nov 27–29 window, so nothing here is built beforehand, and the 1:1 flow comes first. G0 removed group fields from the schema and contracts; this goal would add them back in a new migration.

```
/goal Read CLAUDE.md, docs/build-plan.md and mockups/png/05-group-chip-in.png. Implement the group API and UI: organizer creates, contributors join from a link with no token, progress updates by polling, the goal moves it to wrapped, and the organizer gets a private recipient link. Label contributions as simulated. Done when the transcript shows: API tests for idempotent retries, 20 concurrent contributions never passing the goal, over-contribution refused, exactly one funding-to-wrapped transition, and a group link being unable to open or claim; an e2e test with an organizer, three contributors and a recipient, ending in an on-chain claim of tCOST; a 390x844 screenshot opened and compared to the mockup; all existing tests, `pnpm lint`, `pnpm typecheck`, `pnpm build` exit 0; and work committed on branch g6-chip-in. Constraints: the 1:1 behavior and tests are unchanged. Stop after 35 turns and report what remains.
```

## G7: Conversation view and price feed

```
/goal Read CLAUDE.md, docs/build-plan.md and docs/design.md. Build /demo: sender and recipient threads side by side, labeled "Prototype thread", using the real gift components and API. Add a server price refresh: check current official docs for a feed covering these tickers, record your choice and its staleness rules in docs/prices.md, and fall back to labeled demo prices when missing or stale. Done when the transcript shows: a Playwright test sending from one thread, unwrapping and claiming in the other, and the sender's card updating without reload; tests for fresh, stale, missing and malformed prices where "Live" appears only when fresh; a desktop and a 390px screenshot opened and reviewed; all checks exit 0; and work committed on branch g7-demo. Constraints: never display a price without source and age; no fake activity. Stop after 25 turns and report what remains.
```

## G8: Escrow program

```
/goal Read CLAUDE.md and docs/build-plan.md. Build a Solana escrow program in programs/ for Token-2022 gifts: create locks tokens in a per-gift PDA vault; claim releases them once, no earlier than the open time, authorized by a per-gift claim key whose signature binds the program, gift and recipient; the sender can refund only after expiry. Write docs/escrow.md first with account layout, instructions and threat model. Done when the transcript shows program tests exit 0 for: create and claim; early claim; double claim; wrong claim key; substituted recipient, mint, vault and token program; replay across gifts; refund before and after expiry; claim versus refund ordering; and an unchanged raw amount after a multiplier change. Also show the TypeScript client passing on solana-test-validator, the API using escrow behind a flag that defaults off with existing tests still exit 0, and work committed on branch g8-escrow. Constraints: check current docs for the framework version first; no mainnet; a devnet deploy needs the owner's approval; no upgrade authority change. Stop after 45 turns and report what remains.
```

## G9: iMessage extension (Mac only)

```
/goal Read CLAUDE.md, docs/build-plan.md, docs/design.md and mockups/png. On this Mac, first spike a minimal MSMessageLiveLayout bubble and write docs/imessage-spike.md with observed results: touches in the live bubble, sending from transcript and expanded styles, MSSession update behavior, and bubble reload. Then build the host app (display name, Keychain wallet, app group) and extension for 1:1 compose, wrapped, unwrap, claim and claimed, using the existing API and an MSMessageTemplateLayout alternate. Done when the transcript shows `xcodebuild test` and a Simulator build exit 0; unit tests for URL parsing, state decoding and every error state; Simulator screenshots of both sides of a conversation through claim, opened and compared to mockups 01-04; the claim signature found on devnet; and work committed on branch g9-imessage. Constraints: no signing or Solana SDK on device beyond key generation; no chip-in; if Xcode or signing is missing, stop and say so; report anything seen only in Simulator as untested on device. Stop after 45 turns and report what remains.
```

## G10: Submission

```
/goal Read CLAUDE.md and docs/build-plan.md. Prepare the submission without adding features. Rewrite README.md for judges: what works, deployed link, devnet addresses, real screenshots, architecture, setup, limits, and an accurate before/during section based on git history. Write docs/submission.md with every Dev3pack form field, a shot-by-shot script under 2:30, and an explainer of the Solana design the owner can study. Done when the transcript shows: setup steps run successfully from a fresh clone; every check and e2e test exit 0 and the deployed smoke run passing; every README and docs link checked; a secret scan of full git history finding nothing; each README claim mapped to a test, screenshot or transaction; an open-issues list with severity; and work committed on branch g10-submission. Constraints: no claim of novelty or traction without a source; don't pick a license, publish the repo, deploy to production or submit. Stop after 25 turns and report what remains.
```

## Writing more

`Read <docs>. Build <one outcome>. Done when the transcript shows <commands and observations>. Constraints: <paths, forbidden shortcuts>. Stop after N turns and report what remains.` Limit: 4,000 characters.
