/**
 * Solana client: stub. G1 implements this with @solana/web3.js v1 and
 * @solana/spl-token 0.4.x (Token-2022, Scaled UI Amount). Nothing here talks
 * to a cluster yet.
 *
 * The claim is split into build-and-sign, send and status so the caller can
 * store the signature and last valid block height before sending
 * (docs/build-plan.md § Claim must never pay twice).
 */
import type { MultiplierSchedule, Ticker } from "@stoked/shared";

export interface SignedClaim {
  /** Base58 transaction signature, known before sending. */
  signature: string;
  lastValidBlockHeight: bigint;
  /** Serialized signed transaction. */
  transaction: Uint8Array;
}

export interface BuildClaimInput {
  ticker: Ticker;
  recipientWallet: string;
  raw: bigint;
}

export type ClaimStatus =
  | { state: "confirmed" }
  | { state: "pending" }
  | { state: "expired" } // past lastValidBlockHeight and absent from finalized history
  | { state: "failed"; reason: string };

export interface ChainAdapter {
  /** Idempotent ATA creation plus transferChecked, signed by the treasury. */
  buildClaim(input: BuildClaimInput): Promise<SignedClaim>;
  sendClaim(claim: SignedClaim): Promise<void>;
  claimStatus(signature: string, lastValidBlockHeight: bigint): Promise<ClaimStatus>;
  multiplierSchedule(ticker: Ticker): Promise<MultiplierSchedule>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet (G1)`);
    this.name = "NotImplementedError";
  }
}

/** Placeholder adapter that refuses every call. */
export function createStubChain(): ChainAdapter {
  const refuse = (what: string) => () => Promise.reject(new NotImplementedError(what));
  return {
    buildClaim: refuse("buildClaim"),
    sendClaim: refuse("sendClaim"),
    claimStatus: refuse("claimStatus"),
    multiplierSchedule: refuse("multiplierSchedule"),
  };
}
