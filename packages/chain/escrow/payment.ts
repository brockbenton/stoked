/**
 * What the API needs to take payment from a sender's wallet. Send and track
 * the accepted transaction with the ChainAdapter, and read the gift with the
 * EscrowAdapter.
 */
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { PublicKey, VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import type { Ticker } from "@stoked/shared";
import type { SignedClaim } from "../src/claim";
import { assertSafeCluster } from "../src/cluster";
import { deriveMintAddresses, type MintAddresses } from "../src/mints";
import { buildPaidCreate, cosignPaidCreate, paymentExpiryHeight, type PaidCreate, type RecentBlockhash } from "./paid";
import { deriveClaimKey, giftAddress } from "./program";

export interface PaymentTerms {
  /** Database id; with the claim token it derives the claim key. */
  giftId: string;
  claimKey: string;
  /** The escrow's random gift id, hex. */
  seed: string;
  sender: string;
  ticker: Ticker;
  /** Raw stock units to lock. */
  raw: bigint;
  /** Price in the payment token's base units. */
  amount: bigint;
  openAt: number;
  expiresAt: number;
}

export interface PaymentAdapter {
  /** Decimals of the payment mint. */
  decimals(): Promise<number>;
  /** The claim key's address for a new gift. */
  claimKeyFor(claimToken: string, giftId: string): string;
  funds(sender: string): Promise<{ payment: bigint; lamports: bigint }>;
  /** The unsigned transaction for the sender's wallet, and the gift account it creates. */
  build(terms: PaymentTerms): Promise<{ transaction: Uint8Array; account: string; recent: RecentBlockhash }>;
  /** Verify the wallet-signed transaction and co-sign it. Throws PaymentRejectedError. */
  accept(terms: PaymentTerms, signed: Uint8Array, prepared: RecentBlockhash): Promise<SignedClaim & { account: string }>;
  /** Why the cluster would refuse this transaction now, or null. */
  simulate(transaction: Uint8Array): Promise<string | null>;
}

export interface SolanaPaymentOptions {
  connection: Connection;
  treasury: Keypair;
  programId: PublicKey;
  paymentMint: PublicKey;
  /** Defaults to the addresses derived from the treasury key. */
  mints?: MintAddresses;
}

export function createSolanaPayment(opts: SolanaPaymentOptions): PaymentAdapter {
  const { connection, treasury, programId, paymentMint } = opts;
  const mints = opts.mints ?? deriveMintAddresses(treasury.publicKey);
  if (Object.values(mints).some((m) => m.equals(paymentMint))) throw new Error("a stock mint can't be the payment mint");

  let mintInfo: Promise<{ tokenProgram: PublicKey; decimals: number }> | undefined;
  const paymentInfo = () => {
    mintInfo ??= (async () => {
      await assertSafeCluster(connection);
      const account = await connection.getAccountInfo(paymentMint, "confirmed");
      if (!account) throw new Error("the payment mint doesn't exist on this cluster");
      const { decimals } = await getMint(connection, paymentMint, "confirmed", account.owner);
      if (decimals < 2) throw new Error("the payment mint needs at least 2 decimals");
      return { tokenProgram: account.owner, decimals };
    })().catch((err: unknown) => {
      mintInfo = undefined;
      throw err;
    });
    return mintInfo;
  };

  async function expected(t: PaymentTerms): Promise<PaidCreate & { account: string }> {
    const { tokenProgram, decimals } = await paymentInfo();
    const sender = new PublicKey(t.sender);
    const giftId = new Uint8Array(Buffer.from(t.seed, "hex"));
    return {
      programId,
      sender,
      treasury: treasury.publicKey,
      payment: { mint: paymentMint, tokenProgram, decimals, amount: t.amount },
      gift: {
        mint: mints[t.ticker],
        amount: t.raw,
        giftId,
        claimKey: new PublicKey(t.claimKey),
        openAt: BigInt(t.openAt),
        expiresAt: BigInt(t.expiresAt),
      },
      account: giftAddress(programId, sender, giftId).toBase58(),
    };
  }

  return {
    decimals: async () => (await paymentInfo()).decimals,
    claimKeyFor: (claimToken, giftId) => deriveClaimKey(claimToken, giftId).publicKey.toBase58(),
    async funds(sender) {
      const { tokenProgram } = await paymentInfo();
      const owner = new PublicKey(sender);
      const ata = getAssociatedTokenAddressSync(paymentMint, owner, true, tokenProgram);
      const [lamports, account] = await Promise.all([
        connection.getBalance(owner, "confirmed"),
        connection.getAccountInfo(ata, "confirmed"),
      ]);
      // A token account's amount is the u64 at byte 64 in both token programs.
      const payment = account && account.data.length >= 72 ? Buffer.from(account.data).readBigUInt64LE(64) : 0n;
      return { payment, lamports: BigInt(lamports) };
    },
    async build(terms) {
      const e = await expected(terms);
      const recent = await connection.getLatestBlockhash("confirmed");
      return {
        transaction: buildPaidCreate(e, recent),
        account: e.account,
        recent: { blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight },
      };
    },
    async accept(terms, signed, prepared) {
      const e = await expected(terms);
      await assertSafeCluster(connection);
      const { blockhash, ...cosigned } = cosignPaidCreate(signed, e, treasury);
      return { ...cosigned, lastValidBlockHeight: paymentExpiryHeight(blockhash, prepared), account: e.account };
    },
    async simulate(transaction) {
      const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(transaction), {
        sigVerify: true,
        commitment: "confirmed",
      });
      if (!value.err) return null;
      return `${JSON.stringify(value.err)} ${(value.logs ?? []).slice(-3).join(" | ")}`;
    },
  };
}
