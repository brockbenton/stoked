/**
 * The typed client the UI talks to. G2 ships a fixture implementation; G4
 * swaps in one that calls the real /api routes with the same shapes
 * (docs/build-plan.md § API, schemas in @stoked/shared).
 */
import type {
  ClaimGiftResponse,
  CreateGiftRequest,
  CreateGiftResponse,
  ErrorCode,
  PublicGift,
  Ticker,
} from "@stoked/shared";

export type ClientErrorCode = ErrorCode | "offline";

export class GiftClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GiftClientError";
  }
}

export interface GiftClient {
  createGift(req: CreateGiftRequest): Promise<CreateGiftResponse>;
  getGift(id: string): Promise<PublicGift>;
  /** wrapped → opened. Rejects with `too_early` before opensAt. */
  openGift(id: string, token: string): Promise<PublicGift>;
  /** Only while opened; keeps the USD value. */
  swapGift(id: string, token: string, ticker: Ticker): Promise<PublicGift>;
  /** 200 claimed or 202 pending; retry with the same wallet while pending. */
  claimGift(id: string, token: string, wallet: string): Promise<ClaimGiftResponse>;
}

/** Where the recipient's wallet address comes from. G4 backs this with a WebCrypto key. */
export interface WalletSource {
  getAddress(): Promise<string>;
}
