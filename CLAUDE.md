# CLAUDE.md

Stoked: tokenized-stock gifts in a conversation. Dev3pack hackathon, Solana devnet, hard deadline **Sunday Nov 29, 2026** (exact hour: check the dashboard).

Read `docs/build-plan.md` before coding. It owns the contracts. `docs/goals.md` owns the tasks. `docs/design.md` and `mockups/png/` own the UI. `notes/`, if present, is private background and may be stale; the docs win.

## Decisions

- **Solana devnet, Dev3pack.** No Base work.
- **Web first.** Mac access is unconfirmed, so nothing may depend on iOS. Extension work starts only on a Mac with Xcode.
- **One TypeScript backend:** Next.js route handlers, with Supabase for Postgres. Edge Functions were dropped: the web app is needed regardless, and there's no Docker or Deno here for the local Supabase stack.
- **Wallet:** keypair generated on the recipient's device. Only the public key leaves it. Embedded wallets are out of scope.
- **P2P only.** Group chip-in is deferred: not built before the Nov 27 window, and only considered after the 1:1 flow passes end to end.

## Rules

- Devnet or a local validator only. Never call mainnet with a signer.
- Never commit or print secrets: treasury key, service-role key, claim tokens. Update `.env.example` when adding a variable.
- Clients never sign in v1; the server does every transfer. Server secrets never get a `NEXT_PUBLIC_` prefix.
- Display amount = raw × effective multiplier. Transfers use raw units. Money is integer cents; raw token units are bigint (strings in JSON).
- Pin `@solana/web3.js` to v1 (`^1.95.5`): `@solana/spl-token` 0.4.x requires it and npm's latest is v3.
- Change the API or schema in `docs/build-plan.md` in the same commit as the code.
- Simulated things say so in the UI: devnet tokens, demo prices, prototype chat threads.
- Don't call anything novel or "the first" without a current search.
- Open-source libraries are fine; don't copy another hackathon project.

## Working as an agent

- One goal, one branch (`g3-api`), one worktree. Stay in the paths the goal lists.
- Prove completion by running the goal's checks and showing the output. Never weaken or skip a test to pass.
- If blocked on an account, a key, or a decision, say exactly what's needed and stop.
- Don't merge to `main`, deploy to production, or change repo visibility without the owner.
