/**
 * Test harness: the real migration in PGlite, a fake chain that models
 * signatures, landing, blockhash expiry and dedupe-by-signature, and a
 * controllable clock.
 */
import { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@solana/web3.js";
import type { BuildClaimInput, ChainAdapter, ClaimStatus, SignedClaim } from "@stoked/chain";
import type { MultiplierSchedule, Ticker } from "@stoked/shared";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRateLimiter } from "../../lib/server/rate-limit";
import { createGiftService, type ServiceDeps } from "../../lib/server/service";
import type { GiftStore } from "../../lib/server/store";
import { createSqlGiftStore } from "../../lib/server/store-sql";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "supabase", "migrations");

export async function freshDb(): Promise<PGlite> {
  const db = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  return db;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeSig = () => Array.from(randomBytes(87), (b) => B58[b % 58]).join("");

export interface Transfer {
  signature: string;
  wallet: string;
  ticker: Ticker;
  raw: bigint;
}

/**
 * A transaction lands at most once (by signature) and only while
 * height <= lastValidBlockHeight. `transfers` is what actually moved.
 */
export class FakeChain implements ChainAdapter {
  height = 1000n;
  validFor = 150n;
  transfers: Transfer[] = [];
  built: SignedClaim[] = [];
  sent: string[] = [];
  multiplier: MultiplierSchedule = { multiplier: 1 };
  /** Called before a send; throw to simulate a crash or RPC failure. */
  beforeSend?: (c: SignedClaim) => void;
  /** If false, sends are accepted but don't land (stuck in flight). */
  landOnSend = true;
  private byId = new Map<string, { input: BuildClaimInput; lvh: bigint }>();
  private landed = new Set<string>();

  /** Max random delay in buildClaim (like an RPC round-trip for the blockhash), to widen races. */
  buildJitterMs = 0;

  async buildClaim(input: BuildClaimInput): Promise<SignedClaim> {
    if (this.buildJitterMs) await new Promise((r) => setTimeout(r, Math.random() * this.buildJitterMs));
    const signature = fakeSig();
    const lastValidBlockHeight = this.height + this.validFor;
    this.byId.set(signature, { input, lvh: lastValidBlockHeight });
    const c = { signature, lastValidBlockHeight, transaction: new Uint8Array([1]) };
    this.built.push(c);
    return c;
  }

  async sendClaim(c: SignedClaim): Promise<void> {
    this.beforeSend?.(c);
    this.sent.push(c.signature);
    if (this.landOnSend) this.land(c.signature);
  }

  /** Land a previously built transaction (e.g. a delayed broadcast). */
  land(signature: string): boolean {
    const tx = this.byId.get(signature);
    if (!tx || this.landed.has(signature) || this.height > tx.lvh) return false;
    this.landed.add(signature);
    this.transfers.push({ signature, wallet: tx.input.recipientWallet, ticker: tx.input.ticker, raw: tx.input.raw });
    return true;
  }

  /** Signatures that landed with an error (fee paid, nothing transferred). */
  failedTx = new Set<string>();
  /** Make status lookups throw (RPC down). */
  statusThrows = false;

  /** Land a transaction as failed: it executed with an error, so no tokens moved. */
  landFailed(signature: string) {
    this.failedTx.add(signature);
  }

  async claimStatus(signature: string, lastValidBlockHeight: bigint): Promise<ClaimStatus> {
    if (this.statusThrows) throw new Error("RPC unavailable");
    if (this.failedTx.has(signature)) return { state: "failed", reason: "InstructionError" };
    if (this.landed.has(signature)) return { state: "confirmed" };
    return this.height > lastValidBlockHeight ? { state: "expired" } : { state: "pending" };
  }

  async multiplierSchedule(): Promise<MultiplierSchedule> {
    return this.multiplier;
  }

  advance(blocks: bigint | number) {
    this.height += BigInt(blocks);
  }
}

export const NOW = new Date("2026-11-28T15:00:00.000Z");

export async function setup(overrides: Partial<ServiceDeps> = {}) {
  const db = await freshDb();
  const store: GiftStore = createSqlGiftStore(db);
  const chain = new FakeChain();
  let now = NOW;
  const clock = {
    get: () => now,
    set: (d: Date) => {
      now = d;
    },
  };
  const deps: ServiceDeps = {
    store,
    chain,
    rateLimiter: createRateLimiter({ perKey: 1000, global: 1000, windowMs: 60_000 }),
    now: () => clock.get(),
    confirmPolls: 1,
    confirmIntervalMs: 0,
    ...overrides,
  };
  const service = createGiftService(deps);
  return { db, store, chain, clock, service, deps };
}

export const VALID_WALLET = Keypair.generate().publicKey.toBase58();
export const OTHER_WALLET = Keypair.generate().publicKey.toBase58();

export const giftReq = (over: Record<string, unknown> = {}) => ({
  senderName: "Alex",
  recipientName: "Maya",
  ticker: "tNVDA",
  usdCents: 1000,
  note: "Happy birthday!",
  ...over,
});
