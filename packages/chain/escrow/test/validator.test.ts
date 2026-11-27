/**
 * The TypeScript client against the compiled program on solana-test-validator:
 * pnpm --filter @stoked/chain test:escrow (build the program first).
 */
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  deriveMintAddresses,
  getClaimStatus,
  getTokenBalance,
  sendClaimTransaction,
  setupMints,
  updateMultiplier,
  waitForClaim,
  type SignedClaim,
} from "../../src/index";
import {
  ESCROW_PROGRAM_ID as programId,
  buildCreateGiftTransaction,
  buildEscrowClaimTransaction,
  buildRefundTransaction,
  claimInstruction,
  createSolanaEscrow,
  deriveClaimKey,
  findClaimSignature,
  listGifts,
  readGift,
  refundExpiredGifts,
  vaultAddress,
} from "../index";

const url = process.env.SOLANA_RPC_URL;
if (!url) throw new Error("SOLANA_RPC_URL not set: run via `pnpm test:escrow`");
const connection = new Connection(url, "confirmed");
const treasury = Keypair.generate();
const mint = deriveMintAddresses(treasury.publicKey).tNVDA;
const AMOUNT = 4_356_918n;
const HOUR = 3_600n;

beforeAll(async () => {
  const signature = await connection.requestAirdrop(treasury.publicKey, 100 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
  await setupMints({ connection, treasury, tickers: ["tNVDA"] });
  const info = await connection.getAccountInfo(programId, "confirmed");
  if (!info?.executable) throw new Error("escrow program not loaded: run via `pnpm test:escrow`");
});

const raw = async (owner: PublicKey) => (await getTokenBalance(connection, mint, owner)).raw;

async function vaultRaw(gift: PublicKey): Promise<bigint | null> {
  const vault = vaultAddress(programId, gift);
  if (!(await connection.getAccountInfo(vault, "confirmed"))) return null;
  return BigInt((await connection.getTokenAccountBalance(vault, "confirmed")).value.amount);
}

const clusterTime = async () => (await readGift(connection, programId, Keypair.generate().publicKey)).clusterTime;

async function waitForClusterTime(t: bigint) {
  while ((await clusterTime()) < t) await new Promise((r) => setTimeout(r, 400));
}

async function land(tx: SignedClaim) {
  await sendClaimTransaction(connection, tx);
  expect(await waitForClaim(connection, tx)).toEqual({ state: "confirmed" });
}

async function createGift(window: { opensIn?: bigint; lastsFor?: bigint } = {}) {
  const claimKey = Keypair.generate();
  const now = await clusterTime();
  const openAt = window.opensIn === undefined ? 0n : now + window.opensIn;
  const expiresAt = now + (window.lastsFor ?? HOUR);
  const tx = await buildCreateGiftTransaction({
    connection,
    programId,
    sender: treasury,
    claimKey: claimKey.publicKey,
    mint,
    amount: AMOUNT,
    openAt,
    expiresAt,
  });
  await land(tx);
  return { account: tx.account, claimKey, openAt, expiresAt };
}

const claimTx = (g: { account: PublicKey }, claimKey: Keypair, recipient: PublicKey) =>
  buildEscrowClaimTransaction({ connection, programId, feePayer: treasury, claimKey, account: g.account, recipient });

const wallet = () => Keypair.generate().publicKey;

describe("escrow client on solana-test-validator", () => {
  it("creates a gift that locks the raw units, then claims it once to a new wallet", async () => {
    const before = await raw(treasury.publicKey);
    const g = await createGift();
    expect(await vaultRaw(g.account)).toBe(AMOUNT);
    expect(await raw(treasury.publicKey)).toBe(before - AMOUNT);
    expect((await readGift(connection, programId, g.account)).gift).toMatchObject({
      status: "open",
      sender: treasury.publicKey,
      claimKey: g.claimKey.publicKey,
      mint,
      amount: AMOUNT,
      openAt: 0n,
      expiresAt: g.expiresAt,
      recipient: null,
    });
    expect(await findClaimSignature(connection, programId, g.account)).toBeNull();

    const recipient = wallet(); // no token account yet
    const tx = await claimTx(g, g.claimKey, recipient);
    await land(tx);
    await sendClaimTransaction(connection, tx); // resending the same bytes is a no-op
    expect(await raw(recipient)).toBe(AMOUNT);
    expect(await vaultRaw(g.account)).toBeNull();
    expect((await readGift(connection, programId, g.account)).gift).toMatchObject({ status: "claimed", recipient });
    expect(await findClaimSignature(connection, programId, g.account)).toBe(tx.signature);

    const second = wallet();
    await expect(sendClaimTransaction(connection, await claimTx(g, g.claimKey, second))).rejects.toThrow(
      /AccountNotInitialized|0xbc4/,
    );
    expect(await raw(second)).toBe(0n);
    expect(await raw(recipient)).toBe(AMOUNT);
  });

  it("refuses an early claim and accepts it from the open time", async () => {
    const g = await createGift({ opensIn: 8n });
    const recipient = wallet();
    await expect(sendClaimTransaction(connection, await claimTx(g, g.claimKey, recipient))).rejects.toThrow(
      /TooEarly|0x1777/,
    );
    expect(await vaultRaw(g.account)).toBe(AMOUNT);
    await waitForClusterTime(g.openAt);
    await land(await claimTx(g, g.claimKey, recipient));
    expect(await raw(recipient)).toBe(AMOUNT);
  });

  it("refuses another key, and a signed claim redirected to another wallet", async () => {
    const g = await createGift();
    await expect(sendClaimTransaction(connection, await claimTx(g, Keypair.generate(), wallet()))).rejects.toThrow(
      /WrongClaimKey|0x1773/,
    );

    const intended = wallet();
    const attacker = wallet();
    const signed = Transaction.from((await claimTx(g, g.claimKey, intended)).transaction);
    const gift = (await readGift(connection, programId, g.account)).gift!;
    // Replace the claim instruction with one paying the attacker, keeping the old signatures.
    const redirected = claimInstruction({ programId, gift, claimKey: g.claimKey.publicKey, recipient: attacker });
    signed.instructions[1] = redirected;
    signed.instructions[0]!.keys[1]!.pubkey = getAssociatedTokenAddressSync(mint, attacker, false, TOKEN_2022_PROGRAM_ID);
    signed.instructions[0]!.keys[2]!.pubkey = attacker;
    const forged = signed.serialize({ verifySignatures: false, requireAllSignatures: false });
    await expect(connection.sendRawTransaction(forged)).rejects.toThrow(/signature verification/i);
    expect(await raw(attacker)).toBe(0n);
    expect(await vaultRaw(g.account)).toBe(AMOUNT);
  });

  it("keeps the raw amount through a multiplier change", async () => {
    const g = await createGift();
    await updateMultiplier({ connection, treasury, mint, multiplier: 1.002 });
    expect(await vaultRaw(g.account)).toBe(AMOUNT);
    const recipient = wallet();
    await land(await claimTx(g, g.claimKey, recipient));
    const balance = await getTokenBalance(connection, mint, recipient);
    expect(balance.raw).toBe(AMOUNT);
    expect(balance.shown).toBe("0.0437");
    await updateMultiplier({ connection, treasury, mint, multiplier: 1 });
  });

  it("refunds only after expiry, and a refunded gift can't be claimed", async () => {
    const claimed = await createGift({ lastsFor: 10n });
    const recipient = wallet();
    const expiring = await createGift({ lastsFor: 10n });
    const lasting = await createGift();
    const refundOf = (account: PublicKey) => buildRefundTransaction({ connection, programId, sender: treasury, account });

    await expect(sendClaimTransaction(connection, await refundOf(expiring.account))).rejects.toThrow(
      /NotExpired|0x1779/,
    );
    await land(await claimTx(claimed, claimed.claimKey, recipient));
    expect(await refundExpiredGifts({ connection, programId, sender: treasury })).toEqual([]);

    await waitForClusterTime(expiring.expiresAt);
    // Expired but not yet refunded: the claim is already refused.
    await expect(
      sendClaimTransaction(connection, await claimTx(expiring, expiring.claimKey, wallet())),
    ).rejects.toThrow(/\bExpired\b|0x1778/);

    const before = await raw(treasury.publicKey);
    const refunds = await refundExpiredGifts({ connection, programId, sender: treasury });
    // Not the claimed gift, and not the one still inside its window.
    expect(refunds).toMatchObject([{ account: expiring.account, state: "confirmed" }]);
    expect(await raw(treasury.publicKey)).toBe(before + AMOUNT);
    expect(await vaultRaw(expiring.account)).toBeNull();
    expect(await vaultRaw(lasting.account)).toBe(AMOUNT);
    expect((await readGift(connection, programId, expiring.account)).gift?.status).toBe("refunded");
    await expect(
      sendClaimTransaction(connection, await claimTx(expiring, expiring.claimKey, wallet())),
    ).rejects.toThrow(/AccountNotInitialized|0xbc4/);
    await expect(sendClaimTransaction(connection, await refundOf(claimed.account))).rejects.toThrow(
      /AccountNotInitialized|0xbc4/,
    );
    expect(await raw(recipient)).toBe(AMOUNT);
    expect(await findClaimSignature(connection, programId, expiring.account)).toBeNull();
    expect((await listGifts(connection, programId, treasury.publicKey)).length).toBeGreaterThanOrEqual(3);
  });

  it("works through the adapter with a claim key derived from the claim token", async () => {
    const escrow = createSolanaEscrow({ connection, treasury, programId });
    const giftId = crypto.randomUUID();
    const claimToken = "a".repeat(43);
    const now = Number(await clusterTime());
    const { account, ...create } = await escrow.buildCreate({
      giftId,
      claimToken,
      ticker: "tNVDA",
      raw: AMOUNT,
      openAt: 0,
      expiresAt: now + 3600,
    });
    expect((await escrow.read(account)).gift).toBeNull();
    await land(create);
    expect((await escrow.read(account)).gift).toMatchObject({ status: "open", recipient: null, openAt: 0 });
    expect((await readGift(connection, programId, new PublicKey(account))).gift!.claimKey).toEqual(
      deriveClaimKey(claimToken, giftId).publicKey,
    );
    const recipient = wallet();
    const claim = await escrow.buildClaim({ account, giftId, claimToken, recipientWallet: recipient.toBase58() });
    await land(claim);
    expect((await escrow.read(account)).gift).toMatchObject({ status: "claimed", recipient: recipient.toBase58() });
    expect(await escrow.findClaimSignature(account)).toBe(claim.signature);
    expect(await getClaimStatus(connection, claim.signature, claim.lastValidBlockHeight)).toEqual({ state: "confirmed" });
    expect(await raw(recipient)).toBe(AMOUNT);
  });
});
