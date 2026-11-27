/** Escrow client without a validator or a Rust toolchain (runs in CI). */
import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISCRIMINATORS,
  ESCROW_PROGRAM_ID,
  GIFT_ACCOUNT_SIZE,
  claimInstruction,
  createGiftInstruction,
  decodeGiftAccount,
  deriveClaimKey,
  giftAddress,
  refundInstruction,
  vaultAddress,
} from "../escrow/index";

const TOKEN = "t".repeat(43);
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const key = () => Keypair.generate().publicKey;

describe("claim key derivation", () => {
  it("is stable: changing it would strand unclaimed gifts", () => {
    expect(deriveClaimKey(TOKEN, ID).publicKey.toBase58()).toMatchInlineSnapshot(`"DumKj7HU65dzkA6XRRhbgLMfpnVrzyCHPFaBxtkE4z8U"`);
  });

  it("depends on the token and the gift id, not on the id's letter case", () => {
    const base = deriveClaimKey(TOKEN, ID).publicKey;
    expect(deriveClaimKey(TOKEN, ID.toUpperCase()).publicKey.equals(base)).toBe(true);
    expect(deriveClaimKey(`${TOKEN}x`, ID).publicKey.equals(base)).toBe(false);
    expect(deriveClaimKey(TOKEN, ID.replace("3f", "4f")).publicKey.equals(base)).toBe(false);
  });

  it("can't be rebuilt from the stored token hash", () => {
    const stored = createHash("sha256").update(TOKEN).digest();
    const base = deriveClaimKey(TOKEN, ID).publicKey;
    expect(Keypair.fromSeed(stored).publicKey.equals(base)).toBe(false);
    expect(deriveClaimKey(stored.toString("hex"), ID).publicKey.equals(base)).toBe(false);
  });
});

describe("wire format", () => {
  it("uses the program id declared in the program", () => {
    const source = readFileSync(join(import.meta.dirname, "../../../programs/escrow/src/lib.rs"), "utf8");
    expect(source).toContain(`declare_id!("${ESCROW_PROGRAM_ID.toBase58()}")`);
  });

  it("encodes create_gift arguments little-endian after the discriminator", () => {
    const sender = key();
    const claimKey = key();
    const giftId = new Uint8Array(16).fill(7);
    const ix = createGiftInstruction({
      programId: ESCROW_PROGRAM_ID,
      sender,
      giftId,
      claimKey,
      mint: key(),
      amount: 4_356_918n,
      openAt: 5n,
      expiresAt: 1_800_000_000n,
    });
    expect(ix.data.length).toBe(80);
    expect(ix.data.subarray(0, 8)).toEqual(DISCRIMINATORS.createGift);
    expect([...ix.data.subarray(8, 24)]).toEqual([...giftId]);
    expect(new PublicKey(ix.data.subarray(24, 56)).equals(claimKey)).toBe(true);
    expect(ix.data.readBigUInt64LE(56)).toBe(4_356_918n);
    expect(ix.data.readBigInt64LE(64)).toBe(5n);
    expect(ix.data.readBigInt64LE(72)).toBe(1_800_000_000n);
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey)).toEqual([sender]);
    expect(ix.keys[3]!.pubkey.equals(giftAddress(ESCROW_PROGRAM_ID, sender, giftId))).toBe(true);
  });

  it("refuses amounts outside u64 and gift ids of the wrong size", () => {
    const base = { programId: ESCROW_PROGRAM_ID, sender: key(), claimKey: key(), mint: key(), openAt: 0n, expiresAt: 1n };
    const giftId = new Uint8Array(16);
    expect(() => createGiftInstruction({ ...base, giftId, amount: 0n })).toThrow(RangeError);
    expect(() => createGiftInstruction({ ...base, giftId, amount: 1n << 64n })).toThrow(RangeError);
    expect(() => createGiftInstruction({ ...base, giftId: new Uint8Array(15), amount: 1n })).toThrow(RangeError);
  });

  it("asks only the claim key to sign a claim, and only the sender to sign a refund", () => {
    const gift = { address: key(), sender: key(), mint: key() };
    const claimKey = key();
    const claim = claimInstruction({ programId: ESCROW_PROGRAM_ID, gift, claimKey, recipient: key() });
    expect(claim.keys.filter((k) => k.isSigner)).toEqual([{ pubkey: claimKey, isSigner: true, isWritable: false }]);
    expect(claim.keys[5]!.pubkey.equals(vaultAddress(ESCROW_PROGRAM_ID, gift.address))).toBe(true);
    const refund = refundInstruction({ programId: ESCROW_PROGRAM_ID, gift });
    expect(refund.keys.filter((k) => k.isSigner).map((k) => k.pubkey)).toEqual([gift.sender]);
  });

  it("decodes a gift account at the documented offsets and rejects anything else", () => {
    const address = key();
    const recipient = key();
    const data = Buffer.alloc(GIFT_ACCOUNT_SIZE);
    data.set(DISCRIMINATORS.giftAccount, 0);
    data.writeBigUInt64LE(42n, 120);
    data.writeBigInt64LE(10n, 128);
    data.writeBigInt64LE(20n, 136);
    data.writeUInt8(1, 144);
    data.set(recipient.toBytes(), 145);
    expect(decodeGiftAccount(address, data)).toMatchObject({
      amount: 42n,
      openAt: 10n,
      expiresAt: 20n,
      status: "claimed",
      recipient,
    });
    data.writeUInt8(0, 144);
    expect(decodeGiftAccount(address, data).recipient).toBeNull();
    data.writeUInt8(3, 144);
    expect(() => decodeGiftAccount(address, data)).toThrow(/status/);
    expect(() => decodeGiftAccount(address, data.subarray(1))).toThrow(/not an escrow gift/);
    data.writeUInt8(0, 0);
    expect(() => decodeGiftAccount(address, data)).toThrow(/not an escrow gift/);
  });
});
