/**
 * Solana client on @solana/web3.js v1 and @solana/spl-token 0.4.x
 * (Token-2022, Scaled UI Amount).
 *
 * The claim is split into build-and-sign, send and status so the caller can
 * store the signature and last valid block height before sending
 * (docs/build-plan.md § Claim must never pay twice).
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TICKERS, type MultiplierSchedule, type Ticker } from "@stoked/shared";
import { buildClaimTransaction, getClaimStatus, sendClaimTransaction, type ClaimStatus, type SignedClaim } from "./claim";
import { assertSafeCluster } from "./cluster";
import { deriveMintAddresses, getMultiplierSchedule, type MintAddresses } from "./mints";

export * from "./claim";
export * from "./cluster";
export * from "./mints";

export interface BuildClaimInput {
  ticker: Ticker;
  recipientWallet: string;
  raw: bigint;
}

export interface ChainAdapter {
  /** Idempotent ATA creation plus transferChecked, signed by the treasury. */
  buildClaim(input: BuildClaimInput): Promise<SignedClaim>;
  sendClaim(claim: SignedClaim): Promise<void>;
  claimStatus(signature: string, lastValidBlockHeight: bigint): Promise<ClaimStatus>;
  multiplierSchedule(ticker: Ticker): Promise<MultiplierSchedule>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented`);
    this.name = "NotImplementedError";
  }
}

/** Placeholder adapter that refuses every call (for tests that must not touch a cluster). */
export function createStubChain(): ChainAdapter {
  const refuse = (what: string) => () => Promise.reject(new NotImplementedError(what));
  return {
    buildClaim: refuse("buildClaim"),
    sendClaim: refuse("sendClaim"),
    claimStatus: refuse("claimStatus"),
    multiplierSchedule: refuse("multiplierSchedule"),
  };
}

export interface SolanaChainOptions {
  connection: Connection;
  treasury: Keypair;
  /** Defaults to the addresses derived from the treasury key. */
  mints?: MintAddresses;
}

/** Real adapter. Checks the cluster by genesis hash once, before the first signature. */
export function createSolanaChain(opts: SolanaChainOptions): ChainAdapter {
  const { connection, treasury } = opts;
  const mints = opts.mints ?? deriveMintAddresses(treasury.publicKey);
  let guard: Promise<unknown> | undefined;
  const ensureSafe = () => {
    guard ??= assertSafeCluster(connection).catch((err: unknown) => {
      guard = undefined;
      throw err;
    });
    return guard;
  };
  return {
    async buildClaim({ ticker, recipientWallet, raw }) {
      await ensureSafe();
      return buildClaimTransaction({
        connection,
        treasury,
        mint: mints[ticker],
        recipient: new PublicKey(recipientWallet),
        raw,
      });
    },
    async sendClaim(claim) {
      await ensureSafe();
      await sendClaimTransaction(connection, claim);
    },
    claimStatus: (signature, lastValidBlockHeight) => getClaimStatus(connection, signature, lastValidBlockHeight),
    multiplierSchedule: (ticker) => getMultiplierSchedule(connection, mints[ticker]),
  };
}

/** Parse a JSON byte-array secret key. Never logs the value. */
export function parseSecretKey(json: string): Keypair {
  let bytes: unknown;
  try {
    bytes = JSON.parse(json);
  } catch {
    throw new Error("TREASURY_SECRET_KEY must be a JSON byte array");
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error("TREASURY_SECRET_KEY must be a JSON array of 64 bytes");
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

export const MINT_ENV: Record<Ticker, string> = Object.fromEntries(
  TICKERS.map((t) => [t, `MINT_${t.toUpperCase()}`]),
) as Record<Ticker, string>;

/** Build connection, treasury and mints from env (SOLANA_RPC_URL, TREASURY_SECRET_KEY, MINT_*). */
export function chainConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SolanaChainOptions {
  const url = env.SOLANA_RPC_URL;
  if (!url) throw new Error("SOLANA_RPC_URL is not set");
  const secret = env.TREASURY_SECRET_KEY;
  if (!secret) throw new Error("TREASURY_SECRET_KEY is not set");
  const treasury = parseSecretKey(secret);
  const derived = deriveMintAddresses(treasury.publicKey);
  const mints = Object.fromEntries(
    TICKERS.map((t) => {
      const v = env[MINT_ENV[t]];
      return [t, v ? new PublicKey(v) : derived[t]];
    }),
  ) as MintAddresses;
  return { connection: new Connection(url, "confirmed"), treasury, mints };
}
