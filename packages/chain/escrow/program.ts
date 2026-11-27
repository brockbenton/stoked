/**
 * Wire format of the escrow program (programs/escrow/src/lib.rs, layout in
 * docs/escrow.md): addresses, instructions and the Gift account. No network.
 */
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createHash, hkdfSync } from "node:crypto";

/** `declare_id!` in the program. Deployments are configured with ESCROW_PROGRAM_ID. */
export const ESCROW_PROGRAM_ID = new PublicKey("eXVAv3pDTpMfobKopghfV6BQui7WKx61qcoacRvbtdB");

export const GIFT_ACCOUNT_SIZE = 179;
export const GIFT_ID_BYTES = 16;
const CLAIM_KEY_INFO = "stoked:escrow:claim-key:v1";

const anchorDiscriminator = (preimage: string) => createHash("sha256").update(preimage).digest().subarray(0, 8);
export const DISCRIMINATORS = {
  createGift: anchorDiscriminator("global:create_gift"),
  claim: anchorDiscriminator("global:claim"),
  refund: anchorDiscriminator("global:refund"),
  giftAccount: anchorDiscriminator("account:Gift"),
};

/**
 * The per-gift claim key, derived from the link's claim token and never stored.
 * The database holds sha256(token), from which this can't be derived. Changing
 * this derivation would strand every unclaimed escrow gift until it expires.
 */
export function deriveClaimKey(claimToken: string, giftDbId: string): Keypair {
  const seed = hkdfSync("sha256", claimToken, giftDbId.toLowerCase(), CLAIM_KEY_INFO, 32);
  return Keypair.fromSeed(new Uint8Array(seed));
}

export function giftAddress(programId: PublicKey, sender: PublicKey, giftId: Uint8Array): PublicKey {
  if (giftId.length !== GIFT_ID_BYTES) throw new RangeError(`gift id must be ${GIFT_ID_BYTES} bytes`);
  return PublicKey.findProgramAddressSync([Buffer.from("gift"), sender.toBuffer(), giftId], programId)[0];
}

export function vaultAddress(programId: PublicKey, gift: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), gift.toBuffer()], programId)[0];
}

const ata = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

const signer = (pubkey: PublicKey, isWritable: boolean) => ({ pubkey, isSigner: true, isWritable });
const writable = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const readonly = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

export interface CreateGiftInput {
  programId: PublicKey;
  sender: PublicKey;
  giftId: Uint8Array;
  claimKey: PublicKey;
  mint: PublicKey;
  /** Raw token units. */
  amount: bigint;
  /** Unix seconds, compared with the cluster clock. */
  openAt: bigint;
  expiresAt: bigint;
}

export function createGiftInstruction(i: CreateGiftInput): TransactionInstruction {
  if (i.amount <= 0n || i.amount >= 1n << 64n) throw new RangeError("amount must be a positive u64");
  const gift = giftAddress(i.programId, i.sender, i.giftId);
  const data = Buffer.alloc(8 + 16 + 32 + 8 + 8 + 8);
  data.set(DISCRIMINATORS.createGift, 0);
  data.set(i.giftId, 8);
  data.set(i.claimKey.toBytes(), 24);
  data.writeBigUInt64LE(i.amount, 56);
  data.writeBigInt64LE(i.openAt, 64);
  data.writeBigInt64LE(i.expiresAt, 72);
  return new TransactionInstruction({
    programId: i.programId,
    keys: [
      signer(i.sender, true),
      readonly(i.mint),
      writable(ata(i.mint, i.sender)),
      writable(gift),
      writable(vaultAddress(i.programId, gift)),
      readonly(TOKEN_2022_PROGRAM_ID),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

/** The parts of a Gift account needed to address a claim or refund. */
export interface GiftRef {
  address: PublicKey;
  sender: PublicKey;
  mint: PublicKey;
}

export function claimInstruction(i: {
  programId: PublicKey;
  gift: GiftRef;
  claimKey: PublicKey;
  recipient: PublicKey;
}): TransactionInstruction {
  const { programId, gift } = i;
  return new TransactionInstruction({
    programId,
    keys: [
      signer(i.claimKey, false),
      readonly(i.recipient),
      writable(gift.sender),
      writable(gift.address),
      readonly(gift.mint),
      writable(vaultAddress(programId, gift.address)),
      writable(ata(gift.mint, i.recipient)),
      readonly(TOKEN_2022_PROGRAM_ID),
    ],
    data: Buffer.from(DISCRIMINATORS.claim),
  });
}

export function refundInstruction(i: { programId: PublicKey; gift: GiftRef }): TransactionInstruction {
  const { programId, gift } = i;
  return new TransactionInstruction({
    programId,
    keys: [
      signer(gift.sender, true),
      writable(gift.address),
      readonly(gift.mint),
      writable(vaultAddress(programId, gift.address)),
      writable(ata(gift.mint, gift.sender)),
      readonly(TOKEN_2022_PROGRAM_ID),
    ],
    data: Buffer.from(DISCRIMINATORS.refund),
  });
}

/** Order matches the program's GiftStatus enum. */
const STATUSES = ["open", "claimed", "refunded"] as const;
export type EscrowStatus = (typeof STATUSES)[number];

export interface GiftAccount extends GiftRef {
  giftId: Uint8Array;
  claimKey: PublicKey;
  amount: bigint;
  openAt: bigint;
  expiresAt: bigint;
  status: EscrowStatus;
  /** Null until claimed. */
  recipient: PublicKey | null;
}

/** Decode a Gift account. The caller must already have checked that the program owns it. */
export function decodeGiftAccount(address: PublicKey, data: Uint8Array): GiftAccount {
  const b = Buffer.from(data);
  if (b.length !== GIFT_ACCOUNT_SIZE || !b.subarray(0, 8).equals(DISCRIMINATORS.giftAccount)) {
    throw new Error(`${address.toBase58()} is not an escrow gift account`);
  }
  const key = (at: number) => new PublicKey(b.subarray(at, at + 32));
  const status = STATUSES[b.readUInt8(144)];
  if (!status) throw new Error(`${address.toBase58()} has an unknown status`);
  return {
    address,
    sender: key(8),
    giftId: new Uint8Array(b.subarray(40, 56)),
    claimKey: key(56),
    mint: key(88),
    amount: b.readBigUInt64LE(120),
    openAt: b.readBigInt64LE(128),
    expiresAt: b.readBigInt64LE(136),
    status,
    recipient: status === "claimed" ? key(145) : null,
  };
}
