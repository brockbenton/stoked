# CLAUDE.md

Stoked: tokenized-stock gifts in a conversation. Dev3pack hackathon, Solana devnet, hard deadline **Sunday Nov 29, 2026** (exact hour: check the dashboard). The submission needs a video under 3 minutes, images, the repo, a live link and the team.

Read `docs/build-plan.md` before coding: it owns the architecture and contracts. `docs/escrow.md` covers the escrow program and `docs/devnet.md` the deployed addresses and setup. `notes/`, if present, is private background and may be stale; the docs win.

## Decisions

- **Solana devnet, Dev3pack.** No Base work.
- **Web first.** Mac access is unconfirmed, so nothing may depend on iOS. Extension work starts only on a Mac with Xcode.
- **One TypeScript backend:** Next.js route handlers, with Supabase for Postgres.
- **Wallet:** keypair generated on the recipient's device. Only the public key leaves it. Embedded wallets are out of scope.
- **P2P only.** Group chip-in isn't built.

## Rules

- Devnet or a local validator only. Never call mainnet with a signer.
- Never commit or print secrets: treasury key, deployer or program keypairs, service-role key, claim tokens. Update `.env.example` when adding a variable.
- Clients never sign in v1; the server does every transfer. Server secrets never get a `NEXT_PUBLIC_` prefix.
- Display amount = raw × effective multiplier. Transfers use raw units. Money is integer cents; raw token units are bigint (strings in JSON).
- Pin `@solana/web3.js` to v1 (`^1.95.5`): `@solana/spl-token` 0.4.x requires it and npm's latest is v3.
- Change the API or schema in `docs/build-plan.md` in the same commit as the code.
- Say what's simulated. The README and docs state that the tokens are devnet test tokens and the prices are demo values. At the owner's request the app doesn't label them (pull request #7); never add text implying real stock or live prices.
- Once an escrow gift exists, keep `ESCROW_PROGRAM_ID` set and never roll production back to code without escrow support (`docs/escrow.md`).
- Don't call anything novel or "the first" without a current search.
- Open-source libraries are fine; don't copy another hackathon project.

## Working as an agent

- One task, one branch, one worktree.
- Prove completion by running the relevant checks and showing the output. Never weaken or skip a test to pass.
- If blocked on an account, a key, or a decision, say exactly what's needed and stop.
- Don't merge to `main` (it deploys the live site), deploy to production, or change repo visibility without the owner.
