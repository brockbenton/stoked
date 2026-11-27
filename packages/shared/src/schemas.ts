/**
 * API contract for docs/build-plan.md § API (1:1 gifts only). Every object is
 * strict: unknown keys are rejected, which is how "absent, not just hidden" is
 * enforced for a wrapped gift's ticker, amount and note.
 */
import { z } from "zod";

// ---------- primitives ----------

/** Devnet Token-2022 symbols. These are the tickers everywhere: API, database, UI. */
export const TICKERS = ["tNVDA", "tAAPL", "tSPY", "tTSLA", "tCOST"] as const;
export const Ticker = z.enum(TICKERS);
export type Ticker = z.infer<typeof Ticker>;

/** The stock each test token tracks, for display. */
export const UNDERLYING = {
  tNVDA: { symbol: "NVDA", name: "Nvidia" },
  tAAPL: { symbol: "AAPL", name: "Apple" },
  tSPY: { symbol: "SPY", name: "S&P 500 ETF" },
  tTSLA: { symbol: "TSLA", name: "Tesla" },
  tCOST: { symbol: "COST", name: "Costco" },
} as const satisfies Record<Ticker, { symbol: string; name: string }>;

export const GIFT_AMOUNTS_CENTS = [1000, 2500, 5000] as const;

export const GIFT_STATUSES = ["wrapped", "opened", "claiming", "claimed"] as const;
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
  payment_rejected: 400,
  unauthorized: 401,
  insufficient_funds: 402,
  forbidden: 403,
  not_found: 404,
  invalid_state: 409,
  too_early: 425,
  expired: 410,
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

/** How far ahead a gift can be set to open. Escrow gifts lock tokens at creation, so the server enforces it for them. */
export const MAX_OPENS_AHEAD_MS = 365 * 86_400_000;

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

/** POST /api/gifts */
export const CreateGiftResponse = z.strictObject({
  id: Uuid,
  claimToken: ClaimToken,
});
export type CreateGiftResponse = z.infer<typeof CreateGiftResponse>;

// ---------- wallet payment (docs/escrow.md § Wallet-paid gifts) ----------

/** GET /api/config. `payment` is null when senders don't pay. */
export const AppConfig = z.strictObject({
  payment: z.strictObject({ symbol: z.string().min(1).max(12), mint: WalletAddress }).nullable(),
});
export type AppConfig = z.infer<typeof AppConfig>;

/** A serialized Solana transaction, base58. 1232 bytes is under 1700 characters. */
export const SerializedTransaction = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{100,1700}$/);

/** POST /api/gifts/prepare */
export const PrepareGiftRequest = z.strictObject({ gift: CreateGiftRequest, senderWallet: WalletAddress });
export type PrepareGiftRequest = z.infer<typeof PrepareGiftRequest>;

export const PrepareGiftResponse = z.strictObject({
  id: Uuid,
  claimToken: ClaimToken,
  /** Unsigned: the sender's wallet signs it first. */
  transaction: SerializedTransaction,
  /** The terms, signed by the server. Returned unchanged to /submit. */
  ticket: z.string().min(1).max(4000),
});
export type PrepareGiftResponse = z.infer<typeof PrepareGiftResponse>;

/** POST /api/gifts/submit (claim token in the Authorization header). Safe to repeat. */
export const SubmitGiftRequest = z.strictObject({
  ticket: z.string().min(1).max(4000),
  transaction: SerializedTransaction,
});
export type SubmitGiftRequest = z.infer<typeof SubmitGiftRequest>;

/** 200 once the payment and lock are confirmed, 202 while pending. */
export const SubmitGiftResponse = z.strictObject({
  status: z.enum(["confirmed", "pending"]),
  id: Uuid,
  /** Null if an earlier transaction for the same gift is the one that landed. */
  signature: TransactionSignature.nullable(),
});
export type SubmitGiftResponse = z.infer<typeof SubmitGiftResponse>;

/** POST /api/gifts/:id/open takes no body. */
export const OpenGiftRequest = z.strictObject({});

/** POST /api/gifts/:id/swap */
export const SwapGiftRequest = z.strictObject({ ticker: Ticker });
export type SwapGiftRequest = z.infer<typeof SwapGiftRequest>;

/** POST /api/gifts/:id/claim */
export const ClaimGiftRequest = z.strictObject({ wallet: WalletAddress });
export type ClaimGiftRequest = z.infer<typeof ClaimGiftRequest>;

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

export const PublicGiftWrapped = z.strictObject({ ...base, status: z.literal("wrapped") });
export const PublicGiftOpened = z.strictObject({
  ...base,
  ...contents,
  status: z.literal("opened"),
  /** Present, and false, only when the gift can't be swapped (its tokens are locked in escrow). */
  swappable: z.literal(false).optional(),
});
export const PublicGiftClaiming = z.strictObject({
  ...base,
  ...contents,
  status: z.literal("claiming"),
  recipientWallet: WalletAddress,
  claimSignature: TransactionSignature.nullable(),
});
export const PublicGiftClaimed = z.strictObject({
  ...base,
  ...contents,
  status: z.literal("claimed"),
  recipientWallet: WalletAddress,
  claimSignature: TransactionSignature,
  claimedAt: IsoDateTime,
});

export const PublicGift = z.discriminatedUnion("status", [
  PublicGiftWrapped,
  PublicGiftOpened,
  PublicGiftClaiming,
  PublicGiftClaimed,
]);
export type PublicGift = z.infer<typeof PublicGift>;

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

// ---------- wallet (GET /api/wallets/:address) ----------

export const TokenHolding = z.strictObject({
  ticker: Ticker,
  /** Raw units held on chain. */
  tokenRaw: RawAmount,
  multiplier: MultiplierString,
  /** Display shares, e.g. "0.0436". */
  shares: z.string().regex(/^\d+\.\d+$/),
  /** Raw × multiplier, floored to 8 decimals, e.g. "0.04356918". */
  sharesExact: z.string().regex(/^\d+(\.\d+)?$/),
});
export type TokenHolding = z.infer<typeof TokenHolding>;

/** Only tokens with a non-zero balance are listed, in TICKERS order. */
export const WalletResponse = z.strictObject({
  wallet: WalletAddress,
  holdings: z.array(TokenHolding),
});
export type WalletResponse = z.infer<typeof WalletResponse>;
