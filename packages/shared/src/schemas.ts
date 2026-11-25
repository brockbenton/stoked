/**
 * API contract for docs/build-plan.md § API. Every object is strict: unknown
 * keys are rejected, which is how "absent, not just hidden" is enforced for a
 * wrapped gift's ticker, amount and note.
 */
import { z } from "zod";

// ---------- primitives ----------

/** Underlying tickers. The devnet token for NVDA is tNVDA, and so on. */
export const TICKERS = ["NVDA", "AAPL", "SPY", "TSLA", "COST"] as const;
export const Ticker = z.enum(TICKERS);
export type Ticker = z.infer<typeof Ticker>;

export const TOKEN_SYMBOLS = {
  NVDA: "tNVDA",
  AAPL: "tAAPL",
  SPY: "tSPY",
  TSLA: "tTSLA",
  COST: "tCOST",
} as const satisfies Record<Ticker, string>;

export const GIFT_AMOUNTS_CENTS = [1000, 2500, 5000] as const;
export const GROUP_GOAL_MAX_CENTS = 10000;

export const GiftKind = z.enum(["single", "group"]);
export type GiftKind = z.infer<typeof GiftKind>;

export const GIFT_STATUSES = ["funding", "wrapped", "opened", "claiming", "claimed"] as const;
export const GiftStatus = z.enum(GIFT_STATUSES);
export type GiftStatus = z.infer<typeof GiftStatus>;

export const Uuid = z.uuid();
export const Name = z.string().trim().min(1).max(40);
export const Note = z.string().trim().min(1).max(280);
export const Cents = z.number().int().positive();
export const IsoDateTime = z.iso.datetime({ offset: true });
/** Raw token units: bigint as a decimal string. */
export const RawAmount = z.string().regex(/^\d+$/);
/** Decimal multiplier string, e.g. "1.002". */
export const MultiplierString = z.string().regex(/^\d+(\.\d+)?$/);
/** Base58 Solana address (32-byte key). Format check only; the server decodes it. */
export const WalletAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "invalid wallet address");
export const TransactionSignature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
/** Opaque claim token returned once at creation. */
export const ClaimToken = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

// ---------- errors ----------

export const ERROR_STATUS = {
  bad_request: 400,
  validation_failed: 400,
  invalid_wallet: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_state: 409,
  exceeds_remaining: 409,
  too_early: 425,
  rate_limited: 429,
  internal: 500,
  chain_unavailable: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
export const ErrorCode = z.enum(Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]]);

export const ApiError = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string().min(1),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------- requests ----------

/** POST /api/gifts */
export const CreateGiftRequest = z.strictObject({
  senderName: Name,
  recipientName: Name,
  ticker: Ticker,
  usdCents: z.union(GIFT_AMOUNTS_CENTS.map((c) => z.literal(c))),
  note: Note.optional(),
  opensAt: IsoDateTime.optional(),
});
export type CreateGiftRequest = z.infer<typeof CreateGiftRequest>;

/** POST /api/gifts and POST /api/groups */
export const CreateGiftResponse = z.strictObject({
  id: Uuid,
  claimToken: ClaimToken,
});
export type CreateGiftResponse = z.infer<typeof CreateGiftResponse>;
export const CreateGroupResponse = CreateGiftResponse;
export type CreateGroupResponse = CreateGiftResponse;

/** POST /api/gifts/:id/open takes no body. */
export const OpenGiftRequest = z.strictObject({});

/** POST /api/gifts/:id/swap */
export const SwapGiftRequest = z.strictObject({ ticker: Ticker });
export type SwapGiftRequest = z.infer<typeof SwapGiftRequest>;

/** POST /api/gifts/:id/claim */
export const ClaimGiftRequest = z.strictObject({ wallet: WalletAddress });
export type ClaimGiftRequest = z.infer<typeof ClaimGiftRequest>;

/** POST /api/groups */
export const CreateGroupRequest = z.strictObject({
  organizerName: Name,
  recipientName: Name,
  ticker: Ticker,
  goalCents: Cents.max(GROUP_GOAL_MAX_CENTS),
  opensAt: IsoDateTime.optional(),
  note: Note.optional(),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>;

/** POST /api/groups/:id/contributions */
export const CreateContributionRequest = z.strictObject({
  name: Name,
  usdCents: Cents.max(GROUP_GOAL_MAX_CENTS),
  idempotencyKey: Uuid,
});
export type CreateContributionRequest = z.infer<typeof CreateContributionRequest>;

// ---------- public gift state (GET /api/gifts/:id) ----------

/** Current value, returned only after opening. */
export const GiftValue = z.strictObject({
  priceCents: Cents,
  priceSource: z.string().min(1),
  priceUpdatedAt: IsoDateTime,
  multiplier: MultiplierString,
  /** Display shares, e.g. "0.0436". */
  shares: z.string().regex(/^\d+\.\d+$/),
  valueCents: z.number().int().nonnegative(),
});
export type GiftValue = z.infer<typeof GiftValue>;

const base = {
  id: Uuid,
  senderName: Name,
  recipientName: Name,
  opensAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
};

/** Revealed once opened: what the gift is. */
const contents = {
  ticker: Ticker,
  usdCents: Cents,
  note: Note.nullable(),
  tokenRaw: RawAmount,
  openedAt: IsoDateTime,
  value: GiftValue,
};

const claiming = {
  recipientWallet: WalletAddress,
  claimSignature: TransactionSignature.nullable(),
};

const claimed = {
  recipientWallet: WalletAddress,
  claimSignature: TransactionSignature,
  claimedAt: IsoDateTime,
};

/** Group totals: visible to contributors before opening. Contributor names only. */
const group = {
  ticker: Ticker,
  goalCents: Cents.max(GROUP_GOAL_MAX_CENTS),
  raisedCents: z.number().int().nonnegative(),
  contributors: z.array(Name),
};

const single = { ...base, kind: z.literal("single") };
const grp = { ...base, kind: z.literal("group"), ...group };

// A single gift has no "funding" state: the treasury funds it at creation.
export const PublicSingleWrapped = z.strictObject({ ...single, status: z.literal("wrapped") });
export const PublicSingleOpened = z.strictObject({ ...single, status: z.literal("opened"), ...contents });
export const PublicSingleClaiming = z.strictObject({ ...single, status: z.literal("claiming"), ...contents, ...claiming });
export const PublicSingleClaimed = z.strictObject({ ...single, status: z.literal("claimed"), ...contents, ...claimed });

// Groups show ticker, goal and contributors throughout; the amount and note
// join them at opening. The group page never carries a claim token.
export const PublicGroupFunding = z.strictObject({ ...grp, status: z.literal("funding") });
export const PublicGroupWrapped = z.strictObject({ ...grp, status: z.literal("wrapped") });
const groupContents = (({ ticker: _t, ...rest }) => rest)(contents);
export const PublicGroupOpened = z.strictObject({ ...grp, status: z.literal("opened"), ...groupContents });
export const PublicGroupClaiming = z.strictObject({ ...grp, status: z.literal("claiming"), ...groupContents, ...claiming });
export const PublicGroupClaimed = z.strictObject({ ...grp, status: z.literal("claimed"), ...groupContents, ...claimed });

export const PublicSingleGift = z.discriminatedUnion("status", [
  PublicSingleWrapped,
  PublicSingleOpened,
  PublicSingleClaiming,
  PublicSingleClaimed,
]);
export const PublicGroupGift = z.discriminatedUnion("status", [
  PublicGroupFunding,
  PublicGroupWrapped,
  PublicGroupOpened,
  PublicGroupClaiming,
  PublicGroupClaimed,
]);
export const PublicGift = z.discriminatedUnion("kind", [PublicSingleGift, PublicGroupGift]);
export type PublicGift = z.infer<typeof PublicGift>;
export type PublicSingleGift = z.infer<typeof PublicSingleGift>;
export type PublicGroupGift = z.infer<typeof PublicGroupGift>;

/** GET /api/gifts/:id, POST /open and POST /swap all return the public state. */
export const GetGiftResponse = PublicGift;
export const OpenGiftResponse = PublicGift;
export const SwapGiftResponse = PublicGift;

/** POST /api/gifts/:id/claim: 200 when confirmed, 202 while pending. */
export const ClaimGiftResponse = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("claimed"), signature: TransactionSignature, gift: PublicGift }),
  z.strictObject({ status: z.literal("pending"), signature: TransactionSignature.nullable(), gift: PublicGift }),
]);
export type ClaimGiftResponse = z.infer<typeof ClaimGiftResponse>;

/** POST /api/groups/:id/contributions. A retried idempotency key returns the original contribution. */
export const CreateContributionResponse = z.strictObject({
  contribution: z.strictObject({
    id: Uuid,
    name: Name,
    usdCents: Cents,
    createdAt: IsoDateTime,
  }),
  gift: PublicGroupGift,
});
export type CreateContributionResponse = z.infer<typeof CreateContributionResponse>;
