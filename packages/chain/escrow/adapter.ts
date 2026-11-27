/**
 * What the API needs from the escrow. The server's treasury is the on-chain
 * sender and fee payer; each gift's claim key is derived from its claim token.
 * Send and track the returned transactions with the ChainAdapter.
 */
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";
import type { Ticker } from "@stoked/shared";
import type { SignedClaim } from "../src/claim";
import { assertSafeCluster } from "../src/cluster";
import { deriveMintAddresses, type MintAddresses } from "../src/mints";
import { buildCreateGiftTransaction, buildEscrowClaimTransaction, findClaimSignature, readGift } from "./client";
import { deriveClaimKey, type EscrowStatus } from "./program";

export interface EscrowGiftState {
  status: EscrowStatus;
  /** Wallet that claimed it, or null. */
  recipient: string | null;
  /** Unix seconds, cluster clock. */
  openAt: number;
  expiresAt: number;
}

export interface EscrowAdapter {
  /** Lock a gift's tokens. `account` is the new gift's address. */
  buildCreate(input: {
    giftId: string;
    claimToken: string;
    ticker: Ticker;
    raw: bigint;
    openAt: number;
    expiresAt: number;
  }): Promise<SignedClaim & { account: string }>;
  buildClaim(input: { account: string; giftId: string; claimToken: string; recipientWallet: string }): Promise<SignedClaim>;
  /** On-chain state (null if the gift doesn't exist) and the cluster's time. */
  read(account: string): Promise<{ gift: EscrowGiftState | null; clusterTime: number }>;
  findClaimSignature(account: string): Promise<string | null>;
}

export interface SolanaEscrowOptions {
  connection: Connection;
  treasury: Keypair;
  programId: PublicKey;
  /** Defaults to the addresses derived from the treasury key. */
  mints?: MintAddresses;
}

export function createSolanaEscrow(opts: SolanaEscrowOptions): EscrowAdapter {
  const { connection, treasury, programId } = opts;
  const mints = opts.mints ?? deriveMintAddresses(treasury.publicKey);
  return {
    async buildCreate({ giftId, claimToken, ticker, raw, openAt, expiresAt }) {
      const { account, ...signed } = await buildCreateGiftTransaction({
        connection,
        programId,
        sender: treasury,
        claimKey: deriveClaimKey(claimToken, giftId).publicKey,
        mint: mints[ticker],
        amount: raw,
        openAt: BigInt(openAt),
        expiresAt: BigInt(expiresAt),
      });
      return { ...signed, account: account.toBase58() };
    },
    buildClaim({ account, giftId, claimToken, recipientWallet }) {
      return buildEscrowClaimTransaction({
        connection,
        programId,
        feePayer: treasury,
        claimKey: deriveClaimKey(claimToken, giftId),
        account: new PublicKey(account),
        recipient: new PublicKey(recipientWallet),
      });
    },
    async read(account) {
      // Don't report state from a cluster this server must not use.
      await assertSafeCluster(connection);
      const { gift, clusterTime } = await readGift(connection, programId, new PublicKey(account));
      return {
        gift: gift && {
          status: gift.status,
          recipient: gift.recipient?.toBase58() ?? null,
          openAt: Number(gift.openAt),
          expiresAt: Number(gift.expiresAt),
        },
        clusterTime: Number(clusterTime),
      };
    },
    findClaimSignature: (account) => findClaimSignature(connection, programId, new PublicKey(account)),
  };
}
