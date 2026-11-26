/**
 * Fixture gifts in their public (API) shape, one per status. Prices are demo
 * values, not market data. Wallets and signatures are well-formed
 * placeholders, not real devnet accounts.
 */
import { displayShares, rawToUsdCents, usdToRaw } from "./money";
import type { GiftValue, PublicGift, Ticker } from "./schemas";

export const DEMO_PRICES_CENTS = {
  tNVDA: 22952,
  tAAPL: 27810,
  tSPY: 68240,
  tTSLA: 41275,
  tCOST: 91530,
} as const satisfies Record<Ticker, number>;

export const DEMO_PRICE_SOURCE = "Demo price (not live)";
export const FIXTURE_WALLET = "Gift7nZyQPp4kvXr8DYsUm3a2BcEoFhJ9LqWtRx5Vg6N";
export const FIXTURE_SIGNATURE =
  "5StokedDevnetFixtureSignatureNotRea1111111111111111111111111111111111111111111111111";

const T0 = "2026-11-28T15:00:00.000Z";
const T_OPEN = "2026-11-28T15:05:00.000Z";
const T_CLAIM = "2026-11-28T15:06:00.000Z";
const PRICE_AT = "2026-11-28T14:55:00.000Z";

export function fixtureValue(ticker: Ticker, usdCents: number, multiplier = "1"): { tokenRaw: string; value: GiftValue } {
  const priceCents = DEMO_PRICES_CENTS[ticker];
  const raw = usdToRaw(usdCents, priceCents, multiplier);
  return {
    tokenRaw: raw.toString(),
    value: {
      priceCents,
      priceSource: DEMO_PRICE_SOURCE,
      priceUpdatedAt: PRICE_AT,
      multiplier,
      shares: displayShares(raw, multiplier),
      valueCents: rawToUsdCents(raw, priceCents, multiplier),
    },
  };
}

// Alex sends Maya $10 of tNVDA.
const base = {
  senderName: "Alex",
  recipientName: "Maya",
  opensAt: null,
  createdAt: T0,
};
const nvda = fixtureValue("tNVDA", 1000);
const contents = {
  ticker: "tNVDA" as const,
  usdCents: 1000,
  note: "Happy birthday! Your first share of something.",
  tokenRaw: nvda.tokenRaw,
  openedAt: T_OPEN,
  value: nvda.value,
};

export const giftWrapped: PublicGift = {
  ...base,
  id: "00000000-0000-4000-8000-000000000001",
  status: "wrapped",
};
export const giftWrappedScheduled: PublicGift = {
  ...base,
  id: "00000000-0000-4000-8000-000000000002",
  status: "wrapped",
  opensAt: "2026-12-25T08:00:00.000Z",
};
export const giftOpened: PublicGift = {
  ...base,
  ...contents,
  id: "00000000-0000-4000-8000-000000000003",
  status: "opened",
};
export const giftClaiming: PublicGift = {
  ...base,
  ...contents,
  id: "00000000-0000-4000-8000-000000000004",
  status: "claiming",
  recipientWallet: FIXTURE_WALLET,
  claimSignature: null,
};
export const giftClaimingSent: PublicGift = {
  ...base,
  ...contents,
  id: "00000000-0000-4000-8000-000000000005",
  status: "claiming",
  recipientWallet: FIXTURE_WALLET,
  claimSignature: FIXTURE_SIGNATURE,
};
export const giftClaimed: PublicGift = {
  ...base,
  ...contents,
  id: "00000000-0000-4000-8000-000000000006",
  status: "claimed",
  recipientWallet: FIXTURE_WALLET,
  claimSignature: FIXTURE_SIGNATURE,
  claimedAt: T_CLAIM,
};

export const fixtures = {
  wrapped: giftWrapped,
  wrappedScheduled: giftWrappedScheduled,
  opened: giftOpened,
  claiming: giftClaiming,
  claimingSent: giftClaimingSent,
  claimed: giftClaimed,
} as const;

export const allFixtures: readonly PublicGift[] = Object.values(fixtures);
