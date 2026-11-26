/**
 * Claim transfer, split in three so the caller can persist the signature and
 * last valid block height before anything is broadcast
 * (docs/build-plan.md § Claim must never pay twice):
 *
 *   buildClaim   → idempotent ATA creation + transferChecked, signed by the treasury
 *   sendClaim    → broadcast the exact signed bytes (safe to repeat)
 *   claimStatus  → confirmed | pending | expired | failed
 *
 * Resending the same signed bytes can never pay twice: a signature lands at
 * most once, and the transaction dies after its blockhash expires.
 */
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, Transaction, type Connection, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { DECIMALS } from "./mints";

export interface SignedClaim {
  /** Base58 transaction signature, known before sending. */
  signature: string;
  lastValidBlockHeight: bigint;
  /** Serialized signed transaction. */
  transaction: Uint8Array;
}

export type ClaimStatus =
  | { state: "confirmed" }
  | { state: "pending" }
  | { state: "expired" } // past lastValidBlockHeight and absent from finalized history
  | { state: "failed"; reason: string };

export interface BuildClaimTxInput {
  connection: Connection;
  treasury: Keypair;
  mint: PublicKey;
  recipient: PublicKey;
  raw: bigint;
}

/** Build and sign the claim. Nothing is sent. */
export async function buildClaimTransaction(input: BuildClaimTxInput): Promise<SignedClaim> {
  const { connection, treasury, mint, recipient, raw } = input;
  if (raw <= 0n) throw new RangeError("raw must be positive");
  if (!PublicKey.isOnCurve(recipient.toBytes())) {
    throw new RangeError("recipient must be a wallet address (on-curve public key)");
  }
  const source = getAssociatedTokenAddressSync(mint, treasury.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const destination = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: treasury.publicKey, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      treasury.publicKey,
      destination,
      recipient,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    createTransferCheckedInstruction(
      source,
      mint,
      destination,
      treasury.publicKey,
      raw,
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  tx.sign(treasury);
  if (!tx.signature) throw new Error("signing produced no signature");
  return {
    signature: bs58.encode(tx.signature),
    lastValidBlockHeight: BigInt(lastValidBlockHeight),
    transaction: new Uint8Array(tx.serialize()),
  };
}

function isAlreadyProcessed(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify((err as { logs?: unknown }).logs ?? "")}` : String(err);
  return /already been processed|AlreadyProcessed/i.test(text);
}

/**
 * Broadcast the signed claim. Idempotent: resending bytes that already landed
 * is a no-op (the cluster dedupes by signature) rather than an error.
 */
export async function sendClaimTransaction(connection: Connection, claim: SignedClaim): Promise<string> {
  try {
    await connection.sendRawTransaction(claim.transaction, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 5,
    });
  } catch (err) {
    if (!isAlreadyProcessed(err)) throw err;
  }
  return claim.signature;
}

/**
 * Status of a sent (or possibly never sent) claim.
 * `expired` is only returned once the finalized block height is past
 * `lastValidBlockHeight` and a finalized history lookup finds no landing, so a
 * caller may then safely replace the transaction.
 */
export async function getClaimStatus(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: bigint,
): Promise<ClaimStatus> {
  const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = value[0];
  if (status) {
    if (status.err) return { state: "failed", reason: JSON.stringify(status.err) };
    if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
      return { state: "confirmed" };
    }
    return { state: "pending" };
  }
  const finalizedHeight = BigInt(await connection.getBlockHeight("finalized"));
  if (finalizedHeight <= lastValidBlockHeight) return { state: "pending" };
  // Every block that could contain it is finalized: check finalized history once more.
  const landed = await connection.getTransaction(signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  if (landed) {
    return landed.meta?.err ? { state: "failed", reason: JSON.stringify(landed.meta.err) } : { state: "confirmed" };
  }
  return { state: "expired" };
}

/** Poll until the claim is confirmed, failed or expired. */
export async function waitForClaim(
  connection: Connection,
  claim: Pick<SignedClaim, "signature" | "lastValidBlockHeight">,
  { intervalMs = 400, timeoutMs = 90_000 } = {},
): Promise<ClaimStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await getClaimStatus(connection, claim.signature, claim.lastValidBlockHeight);
    if (s.state !== "pending" || Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
