/**
 * Escrow over RPC. Like the treasury claim (../src/claim.ts), every
 * transaction is built and signed here without being sent, so the caller can
 * store the signature first; send and look it up with sendClaimTransaction and
 * getClaimStatus.
 */
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { sendClaimTransaction, waitForClaim, type SignedClaim } from "../src/claim";
import { assertSafeCluster } from "../src/cluster";
import {
  DISCRIMINATORS,
  GIFT_ACCOUNT_SIZE,
  GIFT_ID_BYTES,
  claimInstruction,
  createGiftInstruction,
  decodeGiftAccount,
  giftAddress,
  refundInstruction,
  type CreateGiftInput,
  type GiftAccount,
} from "./program";

/** Sign with `signers` (the first pays the fee) on a fresh blockhash. Nothing is sent. */
async function sign(connection: Connection, instructions: TransactionInstruction[], signers: Keypair[]): Promise<SignedClaim> {
  await assertSafeCluster(connection);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0]!.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
  tx.sign(...signers);
  if (!tx.signature) throw new Error("signing produced no signature");
  return {
    signature: bs58.encode(tx.signature),
    lastValidBlockHeight: BigInt(lastValidBlockHeight),
    transaction: new Uint8Array(tx.serialize()),
  };
}

const ensureAta = (payer: PublicKey, mint: PublicKey, owner: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(
    payer,
    getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID),
    owner,
    mint,
    TOKEN_2022_PROGRAM_ID,
  );

export type BuildCreateInput = Omit<CreateGiftInput, "sender" | "giftId"> & {
  connection: Connection;
  sender: Keypair;
  /** Random by default. */
  giftId?: Uint8Array;
};

/** Lock `amount` from the sender's associated token account in a new gift. */
export async function buildCreateGiftTransaction(input: BuildCreateInput): Promise<SignedClaim & { account: PublicKey }> {
  const { connection, sender, giftId = new Uint8Array(randomBytes(GIFT_ID_BYTES)), ...terms } = input;
  const instruction = createGiftInstruction({ ...terms, sender: sender.publicKey, giftId });
  const signed = await sign(connection, [instruction], [sender]);
  return { ...signed, account: giftAddress(input.programId, sender.publicKey, giftId) };
}

export interface GiftRead {
  /** Null if no account exists at the address. */
  gift: GiftAccount | null;
  /** The Clock sysvar's unix time: what the program compares against. */
  clusterTime: bigint;
}

export async function readGift(connection: Connection, programId: PublicKey, address: PublicKey): Promise<GiftRead> {
  const [account, clock] = await connection.getMultipleAccountsInfo([address, SYSVAR_CLOCK_PUBKEY], "confirmed");
  if (!clock) throw new Error("clock sysvar unavailable");
  const clusterTime = Buffer.from(clock.data).readBigInt64LE(32);
  if (!account) return { gift: null, clusterTime };
  // Lamports sent to a gift address before creation leave a system-owned account.
  if (!account.owner.equals(programId)) return { gift: null, clusterTime };
  return { gift: decodeGiftAccount(address, account.data), clusterTime };
}

async function requireGift(connection: Connection, programId: PublicKey, address: PublicKey): Promise<GiftAccount> {
  const { gift } = await readGift(connection, programId, address);
  if (!gift) throw new Error(`no escrow gift at ${address.toBase58()}`);
  return gift;
}

/** Idempotent recipient ATA creation plus the program's claim, signed by the fee payer and the claim key. */
export async function buildEscrowClaimTransaction(input: {
  connection: Connection;
  programId: PublicKey;
  feePayer: Keypair;
  claimKey: Keypair;
  account: PublicKey;
  recipient: PublicKey;
}): Promise<SignedClaim> {
  const { connection, programId, feePayer, claimKey, recipient } = input;
  if (!PublicKey.isOnCurve(recipient.toBytes())) {
    throw new RangeError("recipient must be a wallet address (on-curve public key)");
  }
  const gift = await requireGift(connection, programId, input.account);
  return sign(
    connection,
    [
      ensureAta(feePayer.publicKey, gift.mint, recipient),
      claimInstruction({ programId, gift, claimKey: claimKey.publicKey, recipient }),
    ],
    [feePayer, claimKey],
  );
}

/** Return an expired gift to its sender (recreating the sender's token account if it was closed). */
export async function buildRefundTransaction(input: {
  connection: Connection;
  programId: PublicKey;
  sender: Keypair;
  account: PublicKey;
}): Promise<SignedClaim> {
  const { connection, programId, sender } = input;
  const gift = await requireGift(connection, programId, input.account);
  return sign(
    connection,
    [ensureAta(sender.publicKey, gift.mint, gift.sender), refundInstruction({ programId, gift })],
    [sender],
  );
}

/** Every gift this sender created under the program. */
export async function listGifts(connection: Connection, programId: PublicKey, sender: PublicKey): Promise<GiftAccount[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [
      { dataSize: GIFT_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: bs58.encode(DISCRIMINATORS.giftAccount) } },
      { memcmp: { offset: 8, bytes: sender.toBase58() } },
    ],
  });
  return accounts.map((a) => decodeGiftAccount(a.pubkey, a.account.data));
}

export interface RefundResult {
  account: PublicKey;
  /** Null if the refund failed before a transaction was signed. */
  signature: string | null;
  state: "confirmed" | "pending" | "expired" | "failed" | "error";
  /** Why, when state is "error". */
  error?: string;
}

/** Refund each of the sender's open gifts that has expired. Safe to rerun. */
export async function refundExpiredGifts(input: {
  connection: Connection;
  programId: PublicKey;
  sender: Keypair;
}): Promise<RefundResult[]> {
  const { connection, programId, sender } = input;
  await assertSafeCluster(connection);
  const gifts = await listGifts(connection, programId, sender.publicKey);
  const results: RefundResult[] = [];
  for (const gift of gifts) {
    if (gift.status !== "open") continue;
    let signature: string | null = null;
    try {
      const { clusterTime } = await readGift(connection, programId, gift.address);
      if (clusterTime < gift.expiresAt) continue;
      const tx = await buildRefundTransaction({ connection, programId, sender, account: gift.address });
      signature = tx.signature;
      await sendClaimTransaction(connection, tx);
      const status = await waitForClaim(connection, tx);
      results.push({ account: gift.address, signature, state: status.state });
    } catch (err) {
      // One gift's failure must not strand the others. URLs are dropped: an RPC URL can carry a key.
      const why = err instanceof Error ? err.message.replace(/https?:\/\/\S+/g, "<url>").slice(0, 200) : "unknown error";
      results.push({ account: gift.address, signature, state: "error", error: why });
    }
  }
  return results;
}

/**
 * The successful transaction that claimed a gift, from the account's history.
 * Anyone can mention an account in a transaction, so each candidate is checked
 * for this program's claim instruction on this gift.
 */
export async function findClaimSignature(
  connection: Connection,
  programId: PublicKey,
  account: PublicKey,
): Promise<string | null> {
  const history = await connection.getSignaturesForAddress(account, { limit: 100 }, "confirmed");
  for (const { signature, err } of history) {
    if (err) continue;
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) continue;
    const { message } = tx.transaction;
    const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
    const claims = message.compiledInstructions.some((ix) => {
      const gift = ix.accountKeyIndexes[3];
      return (
        keys.get(ix.programIdIndex)?.equals(programId) === true &&
        Buffer.from(ix.data).subarray(0, 8).equals(DISCRIMINATORS.claim) &&
        gift !== undefined &&
        keys.get(gift)?.equals(account) === true
      );
    });
    if (claims) return signature;
  }
  return null;
}
