/**
 * Database adapter. Every state change is a single conditional UPDATE
 * (compare-and-swap): it returns the updated gift, or null when the
 * precondition no longer holds because another request got there first.
 */
import type { GiftStatus, Ticker } from "@stoked/shared";

export interface GiftRecord {
  id: string;
  status: GiftStatus;
  senderName: string;
  recipientName: string;
  ticker: Ticker;
  usdCents: number;
  priceCents: number;
  /** Raw token units, decimal string. */
  tokenRaw: string;
  note: string | null;
  opensAt: string | null;
  claimTokenHash: string;
  recipientWallet: string | null;
  claimSignature: string | null;
  claimLastValidHeight: bigint | null;
  createdAt: string;
  openedAt: string | null;
  claimedAt: string | null;
  /** On-chain escrow account holding the tokens; null for a treasury-transfer gift. Fixed at creation. */
  escrowAccount: string | null;
}

export interface NewGift {
  senderName: string;
  recipientName: string;
  ticker: Ticker;
  usdCents: number;
  priceCents: number;
  tokenRaw: string;
  note: string | null;
  opensAt: string | null;
  claimTokenHash: string;
  /** Server clock, so the durable creation cap and createdAt agree. */
  createdAt: string;
  /** Escrow gifts only: the id (needed before insert to derive the claim key) and the on-chain account. */
  id?: string;
  escrowAccount?: string;
}

export interface PriceRecord {
  usdCents: number;
  source: string;
  updatedAt: string;
}

export interface GiftStore {
  insert(gift: NewGift): Promise<GiftRecord>;
  get(id: string): Promise<GiftRecord | null>;
  /** wrapped → opened. */
  open(id: string, at: string): Promise<GiftRecord | null>;
  /** Only while opened. */
  swap(id: string, next: { ticker: Ticker; priceCents: number; tokenRaw: string }): Promise<GiftRecord | null>;
  /** Claim step 1: opened → claiming, binding the wallet. One caller wins. */
  beginClaim(id: string, wallet: string): Promise<GiftRecord | null>;
  /**
   * Claim step 3 (and 5): store a signed transaction's signature and last
   * valid height while claiming, only if the current signature is still
   * `expected` (null for the first one).
   */
  setClaimTx(id: string, expected: string | null, signature: string, lastValidHeight: bigint): Promise<GiftRecord | null>;
  /** claiming → claimed, only for the stored signature. */
  markClaimed(id: string, signature: string, at: string): Promise<GiftRecord | null>;
  getPrice(ticker: Ticker): Promise<PriceRecord | null>;
  /** Gifts created at or after `since` (ISO), for the durable creation cap. */
  countCreatedSince(since: string): Promise<number>;
}
