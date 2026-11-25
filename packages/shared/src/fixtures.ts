/**
 * Fixture gifts in their public (API) shape, one per status for single and
 * group gifts. Prices are demo values, not market data. Wallets and
 * signatures are well-formed placeholders, not real devnet accounts.
 */
import { displayShares, rawToUsdCents, usdToRaw } from "./money";
import type { GiftValue, PublicGift, PublicGroupGift, PublicSingleGift, Ticker } from "./schemas";

export const DEMO_PRICES_CENTS = {
  NVDA: 22952,
  AAPL: 27810,
  SPY: 68240,
  TSLA: 41275,
  COST: 91530,
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

// ---------- single: Alex sends Maya $10 of NVDA ----------

const singleBase = {
  kind: "single" as const,
  senderName: "Alex",
  recipientName: "Maya",
  opensAt: null,
  createdAt: T0,
};
const nvda = fixtureValue("NVDA", 1000);
const singleContents = {
  ticker: "NVDA" as const,
  usdCents: 1000,
  note: "Happy birthday! Your first share of something.",
  tokenRaw: nvda.tokenRaw,
  openedAt: T_OPEN,
  value: nvda.value,
};

export const singleWrapped: PublicSingleGift = {
  ...singleBase,
  id: "00000000-0000-4000-8000-000000000001",
  status: "wrapped",
};
export const singleWrappedScheduled: PublicSingleGift = {
  ...singleBase,
  id: "00000000-0000-4000-8000-000000000002",
  status: "wrapped",
  opensAt: "2026-12-25T08:00:00.000Z",
};
export const singleOpened: PublicSingleGift = {
  ...singleBase,
  ...singleContents,
  id: "00000000-0000-4000-8000-000000000003",
  status: "opened",
};
export const singleClaiming: PublicSingleGift = {
  ...singleBase,
  ...singleContents,
  id: "00000000-0000-4000-8000-000000000004",
  status: "claiming",
  recipientWallet: FIXTURE_WALLET,
  claimSignature: null,
};
export const singleClaimed: PublicSingleGift = {
  ...singleBase,
  ...singleContents,
  id: "00000000-0000-4000-8000-000000000005",
  status: "claimed",
  recipientWallet: FIXTURE_WALLET,
  claimSignature: FIXTURE_SIGNATURE,
  claimedAt: T_CLAIM,
};

// ---------- group: three friends chip in toward Costco for Grandma ----------

const groupBase = {
  kind: "group" as const,
  senderName: "Jordan",
  recipientName: "Grandma",
  opensAt: null,
  createdAt: T0,
  ticker: "COST" as const,
  goalCents: 7500,
};
const cost = fixtureValue("COST", 7500);
const groupFull = { raisedCents: 7500, contributors: ["Jordan", "Sam", "Priya"] };
const groupContents = {
  usdCents: 7500,
  note: "For all the Costco hot dogs. Love, the grandkids.",
  tokenRaw: cost.tokenRaw,
  openedAt: T_OPEN,
  value: cost.value,
};

export const groupFunding: PublicGroupGift = {
  ...groupBase,
  id: "00000000-0000-4000-8000-000000000011",
  status: "funding",
  raisedCents: 5000,
  contributors: ["Jordan", "Sam"],
};
export const groupWrapped: PublicGroupGift = {
  ...groupBase,
  ...groupFull,
  id: "00000000-0000-4000-8000-000000000012",
  status: "wrapped",
};
export const groupOpened: PublicGroupGift = {
  ...groupBase,
  ...groupFull,
  ...groupContents,
  id: "00000000-0000-4000-8000-000000000013",
  status: "opened",
};
export const groupClaiming: PublicGroupGift = {
  ...groupBase,
  ...groupFull,
  ...groupContents,
  id: "00000000-0000-4000-8000-000000000014",
  status: "claiming",
  recipientWallet: FIXTURE_WALLET,
  claimSignature: FIXTURE_SIGNATURE,
};
export const groupClaimed: PublicGroupGift = {
  ...groupBase,
  ...groupFull,
  ...groupContents,
  id: "00000000-0000-4000-8000-000000000015",
  status: "claimed",
  recipientWallet: FIXTURE_WALLET,
  claimSignature: FIXTURE_SIGNATURE,
  claimedAt: T_CLAIM,
};

export const fixtures = {
  single: {
    wrapped: singleWrapped,
    wrappedScheduled: singleWrappedScheduled,
    opened: singleOpened,
    claiming: singleClaiming,
    claimed: singleClaimed,
  },
  group: {
    funding: groupFunding,
    wrapped: groupWrapped,
    opened: groupOpened,
    claiming: groupClaiming,
    claimed: groupClaimed,
  },
} as const;

export const allFixtures: readonly PublicGift[] = [
  ...Object.values(fixtures.single),
  ...Object.values(fixtures.group),
];
