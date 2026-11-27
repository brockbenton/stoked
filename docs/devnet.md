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

The [escrow program](escrow.md) is at [`eXVAv3pDTpMfobKopghfV6BQui7WKx61qcoacRvbtdB`](https://explorer.solana.com/address/eXVAv3pDTpMfobKopghfV6BQui7WKx61qcoacRvbtdB?cluster=devnet).

Payment token for wallet payments: Circle's devnet USDC, [`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`](https://explorer.solana.com/address/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU?cluster=devnet), 6 decimals.

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

6. Deploy. Vercel builds a preview for each pull request and deploys production when a change is merged to `main`. To deploy a preview by hand, run `vercel deploy --project stoked` from the repo root.

Escrow and wallet payments are off unless you set their variables: see [turning them on](escrow.md#turning-it-on).

### Trying wallet payments

1. Install Phantom, and in its settings turn on Testnet Mode (Developer Settings) with Solana set to Devnet.
2. Get devnet SOL from [faucet.solana.com](https://faucet.solana.com) and devnet USDC from [faucet.circle.com](https://faucet.circle.com) for the sending wallet. A $10 gift costs 10 USDC plus about 0.01 SOL. To change a mint's multiplier, for example to show a dividend, run `pnpm --filter @stoked/chain multiplier tNVDA 1.002`.

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

On a deployment with wallet payments, also set `SMOKE_SENDER_SECRET` to a throwaway devnet keypair (JSON byte array) holding the payment token and some SOL. The test then pays from it, claims to a new wallet and checks both transactions.

## Last verified

All on 2026-11-27 (UTC).

- Smoke test passed on preview `stoked-git-g8-escrow-brockbentons-projects.vercel.app` (commit `e670b4a`, escrow off). It confirmed the genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (devnet). [Claim transaction](https://explorer.solana.com/tx/2nejcNSW7xkpXtQBVpMLq1o9XnsuWJJUTj7NX3mFpPNJ4WhA5ciyDuvEjERH3psvFTEzS5UdDqyZHmWE9FeuUJRQ?cluster=devnet): 4356918 raw tNVDA from the treasury to `8KDMyvNwrU3U3qtymiaudhmAKWDsEtnZEnqZ2kcVEx7S`.
- Wallet smoke test passed on preview `stoked-git-wallet-pay-brockbentons-projects.vercel.app` (commit `18fa8ac`), paying with a stand-in test token and a simulated Phantom. [Payment and escrow](https://explorer.solana.com/tx/3PF34hDRY28w1utnqKFFLkUFdgkD1LugMfchtYqQZAWARky8tPz1LpBdcJAtNdaySZuxwVhaY3CzxjADRhAqEijM?cluster=devnet): 10000000 base units paid, 4356918 raw tNVDA locked. [Claim](https://explorer.solana.com/tx/5piVjDvs7ZvFqtqv9E8mV89bNsMN4vrSuhu6XsN1xPrhHmrUiYqq27YvRAs8S3MEeMgwyYgFdLxFzGmANjm1dRLy?cluster=devnet) to a second wallet.
- On an earlier preview, anonymous reads of `gifts` and `prices`, with both the anon and publishable keys, returned no rows while a gift existed.

## Limits

- Prices are built-in demo values while the `prices` table is empty. The API marks them "Demo price (not live)"; the app doesn't show that.
- Not tested in Safari or on a phone.
- The first smoke test doesn't work with `STOKED_ESCROW=1`: it expects the claim to debit the treasury.
- Wallet payments haven't been tried with the real Phantom app or with Circle's USDC.
- Public devnet RPC can be slow: the smoke test took under 2 minutes.
