/**
 * Token-2022 mint setup and multiplier reads/updates.
 *
 * Each mint lives at an address derived from the treasury key and the ticker
 * (SystemProgram.createAccountWithSeed), so setup is idempotent without any
 * state file: rerunning finds the same addresses and only fills in what's
 * missing (account, metadata, treasury ATA, supply).
 */
import { createHash } from "node:crypto";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  createMintToCheckedInstruction,
  createUpdateMultiplierDataInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMint,
  getMintLen,
  getScaledUiAmountConfig,
  getTokenMetadata,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type Connection,
  type Keypair,
} from "@solana/web3.js";
import {
  TICKERS,
  TOKEN_DECIMALS,
  UNDERLYING,
  displayShares,
  effectiveMultiplier,
  formatUnits,
  rawToShownUnits,
  type MultiplierSchedule,
  type Ratio,
  type Ticker,
} from "@stoked/shared";
import { assertSafeCluster } from "./cluster";

export const DECIMALS = TOKEN_DECIMALS;
/** Default treasury supply per mint: 1,000,000 tokens. */
export const DEFAULT_SUPPLY_RAW = 1_000_000n * 10n ** BigInt(DECIMALS);
const SEED_PREFIX = "stoked:v1:";

export type MintAddresses = Record<Ticker, PublicKey>;

export function mintSeed(ticker: Ticker): string {
  return `${SEED_PREFIX}${ticker}`;
}

/** Deterministic mint address for `ticker` under `treasury`. */
export function deriveMintAddress(treasury: PublicKey, ticker: Ticker): PublicKey {
  // Same derivation as PublicKey.createWithSeed (async in web3.js v1):
  // sha256(base || seed || programId).
  const hash = createHash("sha256")
    .update(treasury.toBuffer())
    .update(mintSeed(ticker))
    .update(TOKEN_2022_PROGRAM_ID.toBuffer())
    .digest();
  return new PublicKey(hash);
}

export function deriveMintAddresses(treasury: PublicKey): MintAddresses {
  return Object.fromEntries(TICKERS.map((t) => [t, deriveMintAddress(treasury, t)])) as MintAddresses;
}

export function tokenMetadataFor(ticker: Ticker, mint: PublicKey, authority: PublicKey): TokenMetadata {
  const u = UNDERLYING[ticker];
  return {
    updateAuthority: authority,
    mint,
    name: `${u.name} (devnet test token)`,
    symbol: ticker,
    uri: "",
    additionalMetadata: [
      ["underlying", u.symbol],
      ["network", "devnet test token, no real value"],
    ],
  };
}

export interface SetupMintsOptions {
  connection: Connection;
  treasury: Keypair;
  /** Raw units to mint to the treasury when its balance is zero. */
  supplyRaw?: bigint;
  tickers?: readonly Ticker[];
}

export interface MintSetupResult {
  ticker: Ticker;
  mint: PublicKey;
  /** Steps performed on this run; empty when everything already existed. */
  actions: Array<"created-mint" | "initialized-metadata" | "created-treasury-ata" | "minted-supply">;
}

/**
 * Create (or complete) the five Token-2022 mints: Scaled UI Amount at
 * multiplier 1.0 with the treasury as authority, metadata pointer to itself,
 * on-mint metadata, 8 decimals, and treasury supply. Idempotent.
 */
export async function setupMints(opts: SetupMintsOptions): Promise<MintSetupResult[]> {
  const { connection, treasury } = opts;
  const supplyRaw = opts.supplyRaw ?? DEFAULT_SUPPLY_RAW;
  await assertSafeCluster(connection);
  const results: MintSetupResult[] = [];
  for (const ticker of opts.tickers ?? TICKERS) {
    results.push(await setupMint(connection, treasury, ticker, supplyRaw));
  }
  return results;
}

async function setupMint(
  connection: Connection,
  treasury: Keypair,
  ticker: Ticker,
  supplyRaw: bigint,
): Promise<MintSetupResult> {
  const authority = treasury.publicKey;
  const mint = deriveMintAddress(authority, ticker);
  const metadata = tokenMetadataFor(ticker, mint, authority);
  const actions: MintSetupResult["actions"] = [];
  const tx = new Transaction();

  const info = await connection.getAccountInfo(mint, "confirmed");
  let needsMetadata = true;
  if (!info) {
    const mintLen = getMintLen([ExtensionType.ScaledUiAmountConfig, ExtensionType.MetadataPointer]);
    // Allocate only the fixed extensions; the metadata initialize reallocs, so
    // fund rent for the final size up front.
    const metadataLen = 2 + 2 + pack(metadata).length; // TLV type + length + data
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);
    tx.add(
      SystemProgram.createAccountWithSeed({
        fromPubkey: authority,
        basePubkey: authority,
        seed: mintSeed(ticker),
        newAccountPubkey: mint,
        lamports,
        space: mintLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMetadataPointerInstruction(mint, authority, mint, TOKEN_2022_PROGRAM_ID),
      createInitializeScaledUiAmountConfigInstruction(mint, authority, 1.0, TOKEN_2022_PROGRAM_ID),
      createInitializeMint2Instruction(mint, DECIMALS, authority, null, TOKEN_2022_PROGRAM_ID),
    );
    actions.push("created-mint");
  } else {
    if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error(`${ticker}: account ${mint.toBase58()} exists but is not a Token-2022 mint`);
    }
    const existing = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (!getScaledUiAmountConfig(existing)) {
      throw new Error(`${ticker}: mint ${mint.toBase58()} lacks the Scaled UI Amount extension`);
    }
    if (existing.decimals !== DECIMALS) {
      throw new Error(`${ticker}: mint ${mint.toBase58()} has ${existing.decimals} decimals, expected ${DECIMALS}`);
    }
    needsMetadata = (await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)) === null;
  }

  if (needsMetadata) {
    tx.add(
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: authority,
        mint,
        mintAuthority: authority,
        name: metadata.name,
        symbol: metadata.symbol,
        uri: metadata.uri,
      }),
    );
    if (info) actions.push("initialized-metadata");
  }

  const ata = getAssociatedTokenAddressSync(mint, authority, false, TOKEN_2022_PROGRAM_ID);
  const ataInfo = info ? await connection.getAccountInfo(ata, "confirmed") : null;
  const balance = ataInfo ? (await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount : 0n;
  if (!ataInfo) {
    tx.add(createAssociatedTokenAccountIdempotentInstruction(authority, ata, authority, mint, TOKEN_2022_PROGRAM_ID));
    actions.push("created-treasury-ata");
  }
  if (balance === 0n && supplyRaw > 0n) {
    tx.add(createMintToCheckedInstruction(mint, ata, authority, supplyRaw, DECIMALS, [], TOKEN_2022_PROGRAM_ID));
    actions.push("minted-supply");
  }

  if (tx.instructions.length > 0) {
    await sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  }
  // additional_metadata fields need their own instructions; they're descriptive
  // only, so we skip them to keep setup to one transaction per mint.
  return { ticker, mint, actions };
}

/** Raw Scaled UI Amount schedule from the mint, in the shape @stoked/shared expects. */
export async function getMultiplierSchedule(connection: Connection, mint: PublicKey): Promise<MultiplierSchedule> {
  const m = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const cfg = getScaledUiAmountConfig(m);
  if (!cfg) throw new Error(`mint ${mint.toBase58()} has no Scaled UI Amount extension`);
  return {
    multiplier: cfg.multiplier,
    newMultiplier: cfg.newMultiplier,
    newMultiplierEffectiveTimestamp: cfg.newMultiplierEffectiveTimestamp,
  };
}

/** True if the mint carries the Scaled UI Amount extension. */
export async function hasScaledUiAmount(connection: Connection, mint: PublicKey): Promise<boolean> {
  const m = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  return getExtensionTypes(m.tlvData).includes(ExtensionType.ScaledUiAmountConfig);
}

/** Cluster time in unix seconds, from the latest confirmed block. Falls back to the local clock. */
export async function clusterNowSeconds(connection: Connection): Promise<number> {
  try {
    const slot = await connection.getSlot("confirmed");
    const t = await connection.getBlockTime(slot);
    if (t != null) return t;
  } catch {
    // fall through
  }
  return Math.floor(Date.now() / 1000);
}

/** Multiplier in force now (scheduled multipliers apply from their timestamp). */
export async function getEffectiveMultiplier(
  connection: Connection,
  mint: PublicKey,
  nowSeconds?: number,
): Promise<Ratio> {
  const schedule = await getMultiplierSchedule(connection, mint);
  return effectiveMultiplier(schedule, nowSeconds ?? (await clusterNowSeconds(connection)));
}

export interface TokenBalance {
  /** Raw units on chain (what transfers move). */
  raw: bigint;
  /** floor(raw × effective multiplier) in 10^-8 share units. */
  shownUnits: bigint;
  /** Exact shown amount, e.g. "0.04365631". */
  shownExact: string;
  /** Display string rounded to 4 decimals, e.g. "0.0437". */
  shown: string;
  multiplier: Ratio;
}

/** Balance of `owner`'s associated token account for `mint`. Zero if the account doesn't exist. */
export async function getTokenBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  nowSeconds?: number,
): Promise<TokenBalance> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  const [info, multiplier] = await Promise.all([
    connection.getAccountInfo(ata, "confirmed"),
    getEffectiveMultiplier(connection, mint, nowSeconds),
  ]);
  const raw = info ? (await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount : 0n;
  const shownUnits = rawToShownUnits(raw, multiplier);
  return {
    raw,
    shownUnits,
    shownExact: formatUnits(shownUnits),
    shown: displayShares(raw, multiplier),
    multiplier,
  };
}

export interface UpdateMultiplierOptions {
  connection: Connection;
  treasury: Keypair;
  mint: PublicKey;
  /** New multiplier, e.g. 1.002. Stored on chain as f64. */
  multiplier: number;
  /** Unix seconds; defaults to the cluster's current time (applies immediately). */
  effectiveTimestamp?: bigint;
}

/** Set a new Scaled UI Amount multiplier. The treasury is the multiplier authority. */
export async function updateMultiplier(opts: UpdateMultiplierOptions): Promise<string> {
  const { connection, treasury, mint, multiplier } = opts;
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new RangeError(`invalid multiplier: ${multiplier}`);
  await assertSafeCluster(connection);
  // Default to the cluster's own time (not the local clock, which can run
  // ahead of it) so the program applies the new multiplier immediately.
  const ts = opts.effectiveTimestamp ?? BigInt(await clusterNowSeconds(connection));
  const tx = new Transaction().add(
    createUpdateMultiplierDataInstruction(mint, treasury.publicKey, multiplier, ts, [], TOKEN_2022_PROGRAM_ID),
  );
  return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
}
