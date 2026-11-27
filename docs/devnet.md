# Devnet

Everything here runs on Solana devnet. The tokens are test tokens with no value, and prices are demo prices.

## Addresses

Treasury (public address): [`4H7CieRb7mFvq2SaNChTcVpVcdLVFtJ5Krf96Dqu7qL3`](https://explorer.solana.com/address/4H7CieRb7mFvq2SaNChTcVpVcdLVFtJ5Krf96Dqu7qL3?cluster=devnet)

Token-2022 mints with Scaled UI Amount, 8 decimals. Each address is derived from the treasury key and the ticker.

| Token | Mint |
|---|---|
| tNVDA | [`AszX3ybKPsWoDTGcweXtura9o1kELSpngD2KMB7dmADQ`](https://explorer.solana.com/address/AszX3ybKPsWoDTGcweXtura9o1kELSpngD2KMB7dmADQ?cluster=devnet) |
| tAAPL | [`3VSL7hpy7EHtZiWkKKXeim9kj1tL6an7WRnwg4HhJcHt`](https://explorer.solana.com/address/3VSL7hpy7EHtZiWkKKXeim9kj1tL6an7WRnwg4HhJcHt?cluster=devnet) |
| tSPY | [`EUh61qmfgXHvoiyNvMsYvBnbpNpWYYQsXzFoRVkUeCBw`](https://explorer.solana.com/address/EUh61qmfgXHvoiyNvMsYvBnbpNpWYYQsXzFoRVkUeCBw?cluster=devnet) |
| tTSLA | [`8fQ4sT2LuEYjq1QGpqAF3PXkokX7t2Eye9kweAf69RL7`](https://explorer.solana.com/address/8fQ4sT2LuEYjq1QGpqAF3PXkokX7t2Eye9kweAf69RL7?cluster=devnet) |
| tCOST | [`8ZymMMA7qsojkgM9KZtdSSDqrm4DvRfEMSMY5yAmhmNJ`](https://explorer.solana.com/address/8ZymMMA7qsojkgM9KZtdSSDqrm4DvRfEMSMY5yAmhmNJ?cluster=devnet) |

## Setup

1. Copy `.env.example` to `.env`. Set `SOLANA_RPC_URL=https://api.devnet.solana.com` and `TREASURY_SECRET_KEY` to a devnet-only keypair (JSON byte array). Never commit or print it.
2. Fund the treasury address at [faucet.solana.com](https://faucet.solana.com). Mint setup used about 0.02 SOL.
3. Create the mints: `pnpm --filter @stoked/chain setup:mints`. Safe to rerun. `MINT_*` variables are optional because the addresses are derived.
4. In the Supabase SQL editor, run the files in `supabase/migrations/` in name order. Check first that the project holds no unrelated tables.
5. In Vercel, set these for Preview and Production, then redeploy:

   | Variable | Value |
   |---|---|
   | `SOLANA_RPC_URL` | The RPC address, starting with `https://` |
   | `TREASURY_SECRET_KEY` | The same keypair, stored as a secret |
   | `SUPABASE_URL` | The Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | The service-role key, stored as a secret |

6. Deploy a preview from the repo root: `vercel deploy --project stoked`.

## Smoke test

Creates, unwraps and claims a $10 gift on a deployment, then looks up the transfer by RPC and checks the mint, recipient and raw amount. It writes a real row and spends a little devnet SOL.

```sh
pnpm --filter @stoked/web exec playwright install chromium   # once
SMOKE_BASE_URL=https://<deployment> \
SMOKE_TREASURY_ADDRESS=4H7CieRb7mFvq2SaNChTcVpVcdLVFtJ5Krf96Dqu7qL3 \
VERCEL_OIDC_TOKEN="$(vercel project token stoked --json | jq -r .token)" \
pnpm --filter @stoked/web test:smoke
```

`VERCEL_OIDC_TOKEN` is only needed for previews, which sit behind Vercel's login.

## Last verified

2026-11-27 (UTC), preview deployment `stoked-1a56wcawu-brockbentons-projects.vercel.app`.

- Genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (devnet).
- Smoke test passed. [Claim transaction](https://explorer.solana.com/tx/3UUs4zCCAccT5gdAGYxgufmbxQ94DjQ5ELHbv7tXqug46AwPYD8NLLMuM5PWHJVqKHNUuSeGrqhpns7cZ8yyRkcJ?cluster=devnet): 4356918 raw tNVDA from the treasury to `9ETkqxS3kaVx9iKdcVk4NAXNx1EJQbtZsy6WuofyeuNi`.
- Anonymous reads of `gifts` and `prices`, with both the anon and publishable keys, returned no rows while a gift existed.

## Limits

- The `prices` table is empty, so the server uses its built-in demo prices. The API marks them "Demo price (not live)"; the app doesn't show that.
- Not tested in Safari or on a phone.
- Public devnet RPC can be slow: the smoke test took under 2 minutes.
