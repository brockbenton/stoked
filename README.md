# Stoked

**Stock gifts that live in the conversation.** Send a friend $10 of Nvidia. They unwrap it, and test tokens representing the stock land in their wallet.

**Live demo:** https://stoked-ebon.vercel.app

Stoked runs on Solana **devnet**. The tokens are test tokens with no monetary value, and prices are fixed demo prices.

## How it works

1. **Send.** Pick a stock (NVDA, AAPL, SPY, TSLA or COST), an amount ($10, $25 or $50), a note and an opening time, then share the private link. Its preview doesn't reveal the contents.
2. **Unwrap.** The recipient opens the gift and can swap it for a different stock.
3. **Claim.** Their browser creates a wallet with a non-exportable private key, and the tokens are sent to it. The sender sees the gift's status update.

To prevent double payment, each claim's transaction signature is stored before sending and checked before any retry.

## Architecture

| Part | Choice |
|---|---|
| Web app and API | Next.js and TypeScript on Vercel |
| Data | Supabase Postgres, accessible only to the server |
| Tokens | Solana Token-2022 mints with Scaled UI Amount, which can represent dividends and splits |
| Escrow | Anchor program |

A server-held treasury funds gifts and sends the transfers; senders don't pay.

### Escrow

The [escrow program](docs/escrow.md) locks each gift's tokens in its own vault, releases them once after the opening time, and allows a refund to the treasury after expiry. It is tested on a local validator and deployed to devnet, but **the live app doesn't use it yet**. It is not trustless: the server creates and signs every claim.

## Devnet addresses

| Account | Address |
|---|---|
| Escrow program | [`eXVAv3pDTpMfobKopghfV6BQui7WKx61qcoacRvbtdB`](https://explorer.solana.com/address/eXVAv3pDTpMfobKopghfV6BQui7WKx61qcoacRvbtdB?cluster=devnet) |
| Treasury | [`4H7CieRb7mFvq2SaNChTcVpVcdLVFtJ5Krf96Dqu7qL3`](https://explorer.solana.com/address/4H7CieRb7mFvq2SaNChTcVpVcdLVFtJ5Krf96Dqu7qL3?cluster=devnet) |

Token mint addresses and setup steps are in [docs/devnet.md](docs/devnet.md).

## Development

Requires Node 22 or later and pnpm. Browser tests also need the Solana CLI and Playwright's Chromium; escrow tests also need Rust.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @stoked/web exec playwright install chromium
pnpm test:e2e
pnpm test:escrow   # not run in CI
```

## Limitations

- Devnet only. The test tokens are not securities.
- Prices are demo values, not market data.
- On the live app, gifts are not held in escrow.
- Anyone with a gift's link can claim it.
- The recipient's wallet exists only in their browser. Clearing site data loses it.
- Not yet tested in Safari or on a phone.
- The escrow program has not been audited.
- A real-money version would need eligibility checks and legal review. Tokenized US stocks such as xStocks are offered only to eligible people outside the US.

## Documentation

- [Architecture](docs/build-plan.md): data, API and claim protocol
- [Escrow](docs/escrow.md): program design, threat model and deployment
- [Devnet](docs/devnet.md): addresses, setup and verification

## Hackathon disclosure

Dev3pack (November 27–29, 2026) allows earlier work and asks teams to disclose it. We found no published start time, so the line is drawn at a commit.

**Before:** everything up to and including the merge of pull request [#9](https://github.com/brockbenton/stoked/pull/9):

- Concept, mockups and build plan ([#1](https://github.com/brockbenton/stoked/pull/1))
- Workspace, shared contracts, database schema and CI ([#2](https://github.com/brockbenton/stoked/pull/2))
- Token-2022 mints and claim transfer ([#3](https://github.com/brockbenton/stoked/pull/3))
- Web app, API, browser wallet and tests ([#4](https://github.com/brockbenton/stoked/pull/4)–[#6](https://github.com/brockbenton/stoked/pull/6))
- Devnet deployment and interface refinements ([#7](https://github.com/brockbenton/stoked/pull/7)–[#9](https://github.com/brockbenton/stoked/pull/9))

**During:**

- Escrow program, TypeScript client, API support behind a feature flag, and design document ([#10](https://github.com/brockbenton/stoked/pull/10))
- Escrow program deployed to devnet ([transaction](https://explorer.solana.com/tx/9NJ8pxkGDWrwDDtsMVa1sEEfdjyqfZXG1ykUTofZUPXMS6zLST9SsSvZitMfwusKEKP37sSDWGtEdz7J6533rLb?cluster=devnet))
- MIT license and documentation cleanup

## License

[MIT](LICENSE)
