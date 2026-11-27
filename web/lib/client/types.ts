/**
 * The typed client the UI talks to: HTTP over the real /api routes, or
 * fixtures for UI tests (docs/build-plan.md § API, schemas in @stoked/shared).
 */
import type {
  AppConfig,
  ClaimGiftResponse,
  CreateGiftRequest,
  CreateGiftResponse,
  ErrorCode,
  PrepareGiftRequest,
  PrepareGiftResponse,
  PublicGift,
  SubmitGiftRequest,
  SubmitGiftResponse,
  Ticker,
  WalletResponse,
} from "@stoked/shared";

export type ClientErrorCode = ErrorCode | "offline" | "wallet_unavailable";

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
  /** What this deployment asks of senders. */
  getConfig(): Promise<AppConfig>;
  /** A priced gift and the transaction for the sender's wallet to sign. */
  prepareGift(req: PrepareGiftRequest): Promise<PrepareGiftResponse>;
  /** Send the signed payment. Repeat while pending. */
  submitGift(token: string, req: SubmitGiftRequest): Promise<SubmitGiftResponse>;
  createGift(req: CreateGiftRequest): Promise<CreateGiftResponse>;
  getGift(id: string): Promise<PublicGift>;
  /** wrapped → opened. Rejects with `too_early` before opensAt. */
  openGift(id: string, token: string): Promise<PublicGift>;
  /** Only while opened; keeps the USD value. */
  swapGift(id: string, token: string, ticker: Ticker): Promise<PublicGift>;
  /** 200 claimed or 202 pending; retry with the same wallet while pending. */
  claimGift(id: string, token: string, wallet: string): Promise<ClaimGiftResponse>;
  /** Test token balances for a wallet address. */
  getWallet(address: string): Promise<WalletResponse>;
}

/** Where the recipient's wallet address comes from (a WebCrypto key on this device). */
export interface WalletSource {
  /** The address, creating the wallet if there isn't one yet. */
  getAddress(): Promise<string>;
  /** The address if a wallet already exists; never creates one. */
  peekAddress(): Promise<string | null>;
}
