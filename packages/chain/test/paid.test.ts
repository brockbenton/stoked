/**
 * What the server will and won't co-sign for a wallet-paid gift. Everything the
 * browser sends back is untrusted: the treasury's signature covers the whole
 * transaction. No network.
 */
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ESCROW_PROGRAM_ID,
  LIGHTHOUSE_PROGRAM_ID,
  PaymentRejectedError,
  WALLET_BLOCKHASH_SLACK,
  buildPaidCreate,
  cosignPaidCreate,
  paidCreateInstructions,
  paymentExpiryHeight,
  type PaidCreate,
} from "../escrow/index";

const sender = Keypair.generate();
const treasury = Keypair.generate();
const recent = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 };

const terms: PaidCreate = {
  programId: ESCROW_PROGRAM_ID,
  sender: sender.publicKey,
  treasury: treasury.publicKey,
  payment: { mint: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6, amount: 10_000_000n },
  gift: {
    mint: Keypair.generate().publicKey,
    amount: 4_356_918n,
    giftId: new Uint8Array(16).fill(7),
    claimKey: Keypair.generate().publicKey,
    openAt: 0n,
    expiresAt: 2_000_000_000n,
  },
};

/** Sign as the wallet would, after optionally changing the instructions. */
function walletSigns(
  change: (ix: TransactionInstruction[]) => TransactionInstruction[] = (ix) => ix,
  { feePayer = sender.publicKey, signers = [sender] } = {},
): Uint8Array {
  const tx = new Transaction({ feePayer, ...recent }).add(...change(paidCreateInstructions(terms)));
  if (signers.length) tx.partialSign(...signers);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

const accept = (bytes: Uint8Array) => cosignPaidCreate(bytes, terms, treasury);
const refused = (bytes: Uint8Array, why?: RegExp) => {
  expect(() => accept(bytes)).toThrow(PaymentRejectedError);
  if (why) expect(() => accept(bytes)).toThrow(why);
};

const lighthouse = (...keys: TransactionInstruction["keys"]) =>
  new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys, data: Buffer.from([5, 0]) });

describe("a wallet-paid gift's transaction", () => {
  it("has an expiry fixed by what was prepared, with room for a wallet's newer blockhash", () => {
    expect(paymentExpiryHeight(recent.blockhash, recent)).toBe(100n);
    expect(paymentExpiryHeight("another", recent)).toBe(100n + WALLET_BLOCKHASH_SLACK);
    expect(accept(walletSigns()).blockhash).toBe(recent.blockhash);
  });

  it("fits in one transaction", () => {
    expect(buildPaidCreate(terms, recent).length).toBeLessThan(1100);
  });

  it("takes the payment, hands over the stock and locks it, in that order", () => {
    const ix = paidCreateInstructions(terms);
    expect(ix).toHaveLength(5);
    expect(ix[1]!.programId).toEqual(TOKEN_PROGRAM_ID);
    expect(ix[3]!.programId).toEqual(TOKEN_2022_PROGRAM_ID);
    expect(ix[4]!.programId).toEqual(ESCROW_PROGRAM_ID);
    // The treasury only signs the stock transfer.
    const signs = ix.map((i) => i.keys.some((k) => k.isSigner && k.pubkey.equals(treasury.publicKey)));
    expect(signs).toEqual([false, false, false, true, false]);
  });

  it("refuses the treasury as sender", () => {
    expect(() => paidCreateInstructions({ ...terms, sender: treasury.publicKey })).toThrow(RangeError);
  });

  it("co-signs exactly what it built", () => {
    const { transaction, signature } = accept(walletSigns());
    const tx = Transaction.from(transaction);
    expect(tx.verifySignatures(true)).toBe(true);
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  });

  it("allows the priority fee and guard instructions a wallet adds", () => {
    const bytes = walletSigns((ix) => [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
      ...ix,
      lighthouse({ pubkey: sender.publicKey, isSigner: false, isWritable: false }),
    ]);
    expect(Transaction.from(accept(bytes).transaction).verifySignatures(true)).toBe(true);
  });

  it("refuses an added instruction that names the treasury", () => {
    refused(
      walletSigns((ix) => [...ix, lighthouse({ pubkey: treasury.publicKey, isSigner: true, isWritable: true })]),
      /names the treasury/,
    );
  });

  it("refuses an extra transfer from the treasury", () => {
    const steal = createTransferCheckedInstruction(
      Keypair.generate().publicKey,
      terms.gift.mint,
      Keypair.generate().publicKey,
      treasury.publicKey,
      1n,
      8,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    refused(walletSigns((ix) => [...ix, steal]));
    refused(
      walletSigns((ix) => [
        ...ix,
        SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: sender.publicKey, lamports: 1 }),
      ]),
    );
  });

  it("refuses an extra instruction from any other program, even without the treasury", () => {
    const other = SystemProgram.transfer({ fromPubkey: sender.publicKey, toPubkey: treasury.publicKey, lamports: 1 });
    refused(walletSigns((ix) => [...ix, other]));
  });

  it.each([
    ["without the payment", (ix: TransactionInstruction[]) => ix.filter((_, i) => i !== 1)],
    ["without the lock", (ix: TransactionInstruction[]) => ix.slice(0, 4)],
    ["reordered", (ix: TransactionInstruction[]) => [ix[0]!, ix[3]!, ix[2]!, ix[1]!, ix[4]!]],
    ["with a repeated stock transfer", (ix: TransactionInstruction[]) => [...ix, ix[3]!]],
  ])("refuses it %s", (_, change) => {
    refused(walletSigns(change));
  });

  it.each<[string, Partial<PaidCreate["payment"]>, Partial<PaidCreate["gift"]>]>([
    ["a smaller payment", { amount: 1n }, {}],
    ["another payment token", { mint: Keypair.generate().publicKey }, {}],
    ["more stock", {}, { amount: 999_999_999n }],
    ["another claim key", {}, { claimKey: Keypair.generate().publicKey }],
    ["a different expiry", {}, { expiresAt: 3_000_000_000n }],
  ])("refuses %s", (_, payment, gift) => {
    const altered = { ...terms, payment: { ...terms.payment, ...payment }, gift: { ...terms.gift, ...gift } };
    const tx = new Transaction({ feePayer: sender.publicKey, ...recent }).add(...paidCreateInstructions(altered));
    tx.partialSign(sender);
    refused(tx.serialize({ requireAllSignatures: false, verifySignatures: false }), /changed/);
  });

  it("refuses an unsigned or wrongly signed transaction", () => {
    refused(walletSigns(undefined, { signers: [] }), /signature/);
    const bytes = Buffer.from(walletSigns());
    bytes[5] = bytes[5]! ^ 1; // inside the sender's signature
    refused(bytes, /signature/);
  });

  it("refuses another fee payer", () => {
    refused(walletSigns(undefined, { feePayer: treasury.publicKey }));
    const third = Keypair.generate();
    refused(walletSigns(undefined, { feePayer: third.publicKey, signers: [third, sender] }));
  });

  it("refuses versioned transactions and junk", () => {
    const message = new TransactionMessage({
      payerKey: sender.publicKey,
      recentBlockhash: recent.blockhash,
      instructions: paidCreateInstructions(terms),
    }).compileToV0Message();
    const v0 = new VersionedTransaction(message);
    v0.sign([sender]);
    refused(v0.serialize(), /version/);
    refused(new Uint8Array([1, 2, 3]));
    refused(new Uint8Array(2000), /too large/);
  });
});
