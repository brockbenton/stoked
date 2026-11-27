/**
 * A gift paid from the sender's own wallet (docs/escrow.md § Wallet-paid
 * gifts). One transaction, signed by the sender and the treasury:
 *
 *   sender pays the gift's price to the treasury
 *   treasury hands the stock tokens to the sender
 *   the sender locks them in the escrow (create_gift)
 *
 * All of it lands or none of it does. The sender's wallet signs first, so the
 * server checks the transaction it gets back, instruction by instruction,
 * before adding the treasury's signature.
 */
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { DECIMALS } from "../src/mints";
import { createGiftInstruction } from "./program";

/** Wallets such as Phantom may add assertions from this program that guard the signer's accounts. */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");

/** The only programs a wallet may add instructions for. */
const WALLET_ADDITIONS = [ComputeBudgetProgram.programId, LIGHTHOUSE_PROGRAM_ID];

/** Largest transaction the network accepts. */
const MAX_TRANSACTION_BYTES = 1232;

export interface PaidCreate {
  programId: PublicKey;
  sender: PublicKey;
  treasury: PublicKey;
  /** What the sender pays with. */
  payment: { mint: PublicKey; tokenProgram: PublicKey; decimals: number; amount: bigint };
  /** What gets locked. `mint` is one of the Token-2022 stock mints. */
  gift: {
    mint: PublicKey;
    amount: bigint;
    giftId: Uint8Array;
    claimKey: PublicKey;
    openAt: bigint;
    expiresAt: bigint;
  };
}

export function paidCreateInstructions(p: PaidCreate): TransactionInstruction[] {
  const { sender, treasury, payment, gift } = p;
  if (sender.equals(treasury)) throw new RangeError("the sender can't be the treasury");
  if (!PublicKey.isOnCurve(sender.toBytes())) throw new RangeError("sender must be a wallet address");
  if (payment.amount <= 0n) throw new RangeError("payment must be positive");
  const payAta = (owner: PublicKey) => getAssociatedTokenAddressSync(payment.mint, owner, false, payment.tokenProgram);
  const stockAta = (owner: PublicKey) => getAssociatedTokenAddressSync(gift.mint, owner, false, TOKEN_2022_PROGRAM_ID);
  return [
    createAssociatedTokenAccountIdempotentInstruction(sender, payAta(treasury), treasury, payment.mint, payment.tokenProgram),
    createTransferCheckedInstruction(
      payAta(sender),
      payment.mint,
      payAta(treasury),
      sender,
      payment.amount,
      payment.decimals,
      [],
      payment.tokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(sender, stockAta(sender), sender, gift.mint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(
      stockAta(treasury),
      gift.mint,
      stockAta(sender),
      treasury,
      gift.amount,
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    createGiftInstruction({ programId: p.programId, sender, ...gift }),
  ];
}

/** The blockhash a transaction was built on. */
export interface RecentBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Blocks a wallet's own, newer blockhash can add to the one we built on: more
 * than pass while a payment request is accepted (10 minutes).
 */
export const WALLET_BLOCKHASH_SLACK = 1800n;

/**
 * The height after which a signed payment can no longer land. It depends only
 * on the transaction and what was prepared, so repeating a submit never moves it.
 */
export function paymentExpiryHeight(signedBlockhash: string, prepared: RecentBlockhash): bigint {
  const built = BigInt(prepared.lastValidBlockHeight);
  return signedBlockhash === prepared.blockhash ? built : built + WALLET_BLOCKHASH_SLACK;
}

/** The unsigned transaction handed to the sender's wallet. */
export function buildPaidCreate(p: PaidCreate, recent: RecentBlockhash): Uint8Array {
  const tx = new Transaction({ feePayer: p.sender, ...recent }).add(...paidCreateInstructions(p));
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

export class PaymentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentRejectedError";
  }
}

const reject = (why: string): never => {
  throw new PaymentRejectedError(why);
};

/**
 * Check a transaction the sender's wallet signed, then add the treasury's
 * signature. It must contain exactly the instructions of `paidCreateInstructions`
 * in order. Extra instructions are allowed only from the compute budget and
 * Lighthouse programs, and none may name the treasury: a signature covers the
 * whole transaction, so anything else naming it could spend with its authority.
 */
export function cosignPaidCreate(
  signed: Uint8Array,
  expected: PaidCreate,
  treasury: Keypair,
): { transaction: Uint8Array; signature: string; blockhash: string } {
  if (!treasury.publicKey.equals(expected.treasury)) throw new Error("wrong treasury key");
  if (signed.length > MAX_TRANSACTION_BYTES) reject("transaction is too large");
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(signed);
  } catch {
    return reject("not a Solana transaction");
  }
  const { message } = tx;
  if (message.version !== "legacy") reject("unsupported transaction version");
  const keys = message.staticAccountKeys;
  const signers = keys.slice(0, message.header.numRequiredSignatures);
  if (signers.length !== 2) reject("unexpected signers");
  if (!signers[0]!.equals(expected.sender)) reject("the connected wallet must pay the fee");
  if (!signers[1]!.equals(expected.treasury)) reject("unexpected signers");

  const wanted = paidCreateInstructions(expected);
  let next = 0;
  for (const ix of message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    const accounts = ix.accountKeyIndexes.map((i) => keys[i]);
    if (!program || accounts.some((a) => !a)) reject("malformed instruction");
    if (WALLET_ADDITIONS.some((id) => id.equals(program!))) {
      if (accounts.some((a) => a!.equals(expected.treasury))) reject("an added instruction names the treasury");
      continue;
    }
    const want = wanted[next++];
    const same =
      want !== undefined &&
      want.programId.equals(program!) &&
      want.keys.length === accounts.length &&
      want.keys.every((k, i) => k.pubkey.equals(accounts[i]!)) &&
      Buffer.from(want.data).equals(Buffer.from(ix.data));
    if (!same) reject("the transaction was changed");
  }
  if (next !== wanted.length) reject("the transaction was changed");

  // The sender's signature must be present and match these exact bytes.
  const check = (bytes: Uint8Array, requireAll: boolean) => {
    const legacy = Transaction.from(bytes);
    return legacy.signature !== null && legacy.verifySignatures(requireAll);
  };
  tx.signatures[1] = new Uint8Array(64);
  if (!check(tx.serialize(), false)) reject("the wallet's signature is missing or wrong");
  tx.sign([treasury]);
  const transaction = tx.serialize();
  if (!check(transaction, true)) reject("the wallet's signature is missing or wrong");
  return { transaction, signature: bs58.encode(tx.signatures[0]!), blockhash: message.recentBlockhash };
}
