/**
 * Wallet-paid gifts through the service: the real transaction builder and
 * checks, the real migration, and a fake cluster.
 */
import type { PGlite } from "@electric-sql/pglite";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { ClaimStatus, SignedClaim } from "@stoked/chain";
import {
  ESCROW_PROGRAM_ID,
  buildPaidCreate,
  cosignPaidCreate,
  deriveClaimKey,
  giftAddress,
  type EscrowAdapter,
  type PaymentAdapter,
  type PaymentTerms,
} from "@stoked/chain/escrow";
import { PrepareGiftResponse } from "@stoked/shared";
import bs58 from "bs58";
import { beforeAll, describe, expect, it } from "vitest";
import { paymentSettings } from "../../lib/server/env";
import { createRateLimiter } from "../../lib/server/rate-limit";
import { PAYMENT_TICKET_TTL_MS, createGiftService, type ServiceDeps } from "../../lib/server/service";
import { createSqlGiftStore } from "../../lib/server/store-sql";
import { readTicket, signTicket } from "../../lib/server/ticket";
import { FakeChain, NOW, VALID_WALLET, freshDb, giftReq } from "./harness";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const treasury = Keypair.generate();
const paymentMint = Keypair.generate().publicKey;
const stockMint = Keypair.generate().publicKey;
const ticketKey = new Uint8Array(32).fill(3);

/** A cluster where a sent payment locks its gift, unless told otherwise. */
function world(options: Partial<ServiceDeps> = {}) {
  const clock = { now: new Date(NOW) };
  const chain = new FakeChain();
  const state = {
    funds: { payment: 100_000_000n, lamports: 1_000_000_000n },
    simulation: null as string | null,
    lands: true,
    sends: 0,
    locked: new Set<string>(),
    statuses: new Map<string, ClaimStatus>(),
  };
  const pendingAccounts = new Map<string, string>();
  const recent = () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 500 });
  const expected = (t: PaymentTerms) => {
    const giftId = new Uint8Array(Buffer.from(t.seed, "hex"));
    const sender = new PublicKey(t.sender);
    return {
      terms: {
        programId: ESCROW_PROGRAM_ID,
        sender,
        treasury: treasury.publicKey,
        payment: { mint: paymentMint, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6, amount: t.amount },
        gift: {
          mint: stockMint,
          amount: t.raw,
          giftId,
          claimKey: new PublicKey(t.claimKey),
          openAt: BigInt(t.openAt),
          expiresAt: BigInt(t.expiresAt),
        },
      },
      account: giftAddress(ESCROW_PROGRAM_ID, sender, giftId).toBase58(),
    };
  };
  const adapter: PaymentAdapter = {
    decimals: async () => 6,
    claimKeyFor: (token, id) => deriveClaimKey(token, id).publicKey.toBase58(),
    funds: async () => state.funds,
    async build(t) {
      const e = expected(t);
      const at = recent();
      return { transaction: buildPaidCreate(e.terms, at), account: e.account, recent: at };
    },
    async accept(t, signed) {
      const e = expected(t);
      const cosigned = cosignPaidCreate(signed, e.terms, treasury);
      pendingAccounts.set(cosigned.signature, e.account);
      return { ...cosigned, lastValidBlockHeight: 500n, account: e.account };
    },
    simulate: async () => state.simulation,
  };
  chain.sendClaim = async (tx: SignedClaim) => {
    state.sends += 1;
    if (!state.lands) return;
    state.locked.add(pendingAccounts.get(tx.signature)!);
    state.statuses.set(tx.signature, { state: "confirmed" });
  };
  chain.claimStatus = async (signature) => state.statuses.get(signature) ?? { state: "pending" };
  const escrow: EscrowAdapter = {
    buildCreate: () => Promise.reject(new Error("not used: the sender creates")),
    buildClaim: () => Promise.reject(new Error("not used here")),
    read: async (account) => ({
      gift: state.locked.has(account) ? { status: "open", recipient: null, openAt: 0, expiresAt: 4_000_000_000 } : null,
      clusterTime: Math.floor(clock.now.getTime() / 1000),
    }),
    findClaimSignature: async () => null,
  };
  const service = createGiftService({
    store: createSqlGiftStore(db),
    chain,
    rateLimiter: createRateLimiter({ perKey: 1000, global: 1000, windowMs: 60_000 }),
    now: () => clock.now,
    confirmPolls: 0,
    confirmIntervalMs: 0,
    creationCap: { max: 10_000, windowMs: 3_600_000 },
    escrow: { adapter: escrow, createGifts: false },
    payments: { adapter, ticketKey, symbol: "USDC", confirmPolls: 2 },
    ...options,
  });
  return { service, state, clock };
}

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});

const sender = Keypair.generate();
const request = (over: object = {}) => ({ gift: { ...giftReq(), ...over }, senderWallet: sender.publicKey.toBase58() });

function walletSigns(transaction: string, key = sender): string {
  const tx = Transaction.from(bs58.decode(transaction));
  tx.partialSign(key);
  return bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

async function prepared(w: ReturnType<typeof world>) {
  const p = PrepareGiftResponse.parse(await w.service.prepare(request(), "1.2.3.4"));
  return { ...p, signed: walletSigns(p.transaction) };
}

const submit = (w: ReturnType<typeof world>, p: Awaited<ReturnType<typeof prepared>>, token = p.claimToken) =>
  w.service.submit(token, { ticket: p.ticket, transaction: p.signed });

const row = async (id: string) =>
  (await db.query<{ n: number; escrow_account: string }>("select escrow_account from gifts where id = $1", [id])).rows;

const code = (c: string) => expect.objectContaining({ code: c });

describe("prepare", () => {
  it("stores nothing and sends nothing until the wallet has signed", async () => {
    const w = world();
    const p = await prepared(w);
    expect(await row(p.id)).toHaveLength(0);
    expect(w.state.sends).toBe(0);
    // The browser gets the transaction without the treasury's signature.
    const tx = Transaction.from(bs58.decode(p.transaction));
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
  });

  it("charges the dollar amount in the payment token", async () => {
    const w = world();
    const p = await prepared(w);
    expect(readTicket(ticketKey, p.ticket)).toMatchObject({ amount: "10000000", usdCents: 1000, tokenRaw: "4356918" });
  });

  it.each([
    [{ payment: 9_999_999n, lamports: 1_000_000_000n }, /USDC/],
    [{ payment: 10_000_000n, lamports: 9_999_999n }, /SOL/],
  ])("refuses a wallet that can't pay", async (funds, why) => {
    const w = world();
    w.state.funds = funds;
    const result = w.service.prepare(request(), "ip");
    await expect(result).rejects.toEqual(code("insufficient_funds"));
    await expect(w.service.prepare(request(), "ip")).rejects.toThrow(why);
  });

  it("refuses a bad wallet, a past opening time and one beyond a year", async () => {
    const w = world();
    await expect(
      w.service.prepare({ gift: giftReq(), senderWallet: "11111111111111111111111111111112x" }, "ip"),
    ).rejects.toEqual(code("invalid_wallet"));
    for (const opensAt of [new Date(NOW.getTime() - 1000), new Date(NOW.getTime() + 400 * 86_400_000)]) {
      await expect(w.service.prepare(request({ opensAt: opensAt.toISOString() }), "ip")).rejects.toEqual(
        code("validation_failed"),
      );
    }
  });

  it("is rate limited", async () => {
    const w = world({ rateLimiter: createRateLimiter({ perKey: 1, global: 10, windowMs: 60_000 }) });
    await w.service.prepare(request(), "ip");
    await expect(w.service.prepare(request(), "ip")).rejects.toEqual(code("rate_limited"));
  });

  it("closes free creation", async () => {
    await expect(world().service.create(giftReq(), "ip")).rejects.toEqual(code("forbidden"));
  });

  it("is refused where payments aren't on", async () => {
    const w = world({ payments: undefined });
    await expect(w.service.prepare(request(), "ip")).rejects.toEqual(code("invalid_state"));
  });
});

describe("submit", () => {
  it("records the gift, sends once and answers with the payment's signature", async () => {
    const w = world();
    const p = await prepared(w);
    const r = await submit(w, p);
    expect(r).toMatchObject({ httpStatus: 200, body: { status: "confirmed", id: p.id } });
    expect(r.body.signature).toBeTruthy();
    expect(await row(p.id)).toHaveLength(1);
    const gift = await w.service.get(p.id);
    expect(gift.status).toBe("wrapped");
    const opened = await w.service.open(p.id, p.claimToken);
    expect(opened).toMatchObject({ status: "opened", swappable: false, usdCents: 1000 });
  });

  it("is safe to repeat", async () => {
    const w = world();
    const p = await prepared(w);
    const first = await submit(w, p);
    const again = await submit(w, p);
    expect(again.body).toEqual(first.body);
    expect(w.state.sends).toBe(1);
    expect(await row(p.id)).toHaveLength(1);
  });

  it("survives concurrent submits with one row", async () => {
    const w = world();
    const p = await prepared(w);
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(w, p)));
    expect(results.every((r) => r.body.status === "confirmed")).toBe(true);
    expect(await row(p.id)).toHaveLength(1);
  });

  it("answers 202 until it lands, even long after the ticket's age limit", async () => {
    const w = world();
    w.state.lands = false;
    const p = await prepared(w);
    expect(await submit(w, p)).toMatchObject({ httpStatus: 202, body: { status: "pending" } });
    w.clock.now = new Date(NOW.getTime() + PAYMENT_TICKET_TTL_MS * 2);
    w.state.lands = true;
    expect(await submit(w, p)).toMatchObject({ httpStatus: 200, body: { status: "confirmed" } });
  });

  it.each<ClaimStatus>([{ state: "expired" }, { state: "failed", reason: "x" }])(
    "says nothing was charged when the transaction is $state and no gift exists",
    async (status) => {
      const w = world();
      w.state.lands = false;
      const p = await prepared(w);
      const first = await submit(w, p);
      w.state.statuses.set(first.body.signature!, status);
      await expect(submit(w, p)).rejects.toThrow(/no USDC left the wallet/);
    },
  );

  it("sends nothing and stores nothing when the cluster would refuse it", async () => {
    const w = world();
    w.state.simulation = '{"InstructionError":[1,{"Custom":1}]} insufficient funds';
    const p = await prepared(w);
    await expect(submit(w, p)).rejects.toThrow(/doesn't have enough/);
    expect(w.state.sends).toBe(0);
    expect(await row(p.id)).toHaveLength(0);
  });

  it("says nothing was sent when the gift can't be saved", async () => {
    const real = createSqlGiftStore(db);
    const w = world({ store: { ...real, insert: () => Promise.reject(new Error("column does not exist")) } });
    const p = await prepared(w);
    await expect(submit(w, p)).rejects.toThrow(/nothing was sent/);
    expect(w.state.sends).toBe(0);
  });

  it("refuses a stale first submit", async () => {
    const w = world();
    const p = await prepared(w);
    w.clock.now = new Date(NOW.getTime() + PAYMENT_TICKET_TTL_MS + 1000);
    await expect(submit(w, p)).rejects.toEqual(code("payment_rejected"));
    expect(w.state.sends).toBe(0);
  });

  it("needs the gift's own token", async () => {
    const w = world();
    const p = await prepared(w);
    const other = await prepared(w);
    await expect(w.service.submit(null, { ticket: p.ticket, transaction: p.signed })).rejects.toEqual(code("unauthorized"));
    await expect(submit(w, p, other.claimToken)).rejects.toEqual(code("forbidden"));
  });

  it("refuses a ticket it didn't sign, or one edited to pay less", async () => {
    const w = world();
    const p = await prepared(w);
    const real = readTicket(ticketKey, p.ticket)!;
    const cheaper = { ...real, amount: "1" };
    const forged = signTicket(new Uint8Array(32).fill(9), cheaper);
    const edited = `${Buffer.from(JSON.stringify(cheaper)).toString("base64url")}.${p.ticket.split(".")[1]}`;
    for (const ticket of [forged, edited, "junk", `${p.ticket}.x`]) {
      await expect(w.service.submit(p.claimToken, { ticket, transaction: p.signed })).rejects.toEqual(
        code("validation_failed"),
      );
    }
    expect(w.state.sends).toBe(0);
  });

  it("refuses a transaction that isn't this gift's, or isn't the sender's", async () => {
    const w = world();
    const p = await prepared(w);
    const other = await prepared(w);
    for (const transaction of [other.signed, p.transaction]) {
      await expect(w.service.submit(p.claimToken, { ticket: p.ticket, transaction })).rejects.toEqual(
        code("payment_rejected"),
      );
    }
    expect(w.state.sends).toBe(0);
    expect(await row(p.id)).toHaveLength(0);
  });

  it("claims to the wallet the recipient connects", async () => {
    const w = world();
    const p = await prepared(w);
    await submit(w, p);
    await w.service.open(p.id, p.claimToken);
    // The fake escrow doesn't build claims: reaching that step shows the claim is routed to it.
    await expect(w.service.claim(p.id, p.claimToken, { wallet: VALID_WALLET })).rejects.toEqual(code("chain_unavailable"));
    expect((await w.service.get(p.id)).status).toBe("claiming");
  });
});

describe("settings", () => {
  it("is off without a payment mint and needs the escrow program with one", () => {
    expect(paymentSettings({})).toBeUndefined();
    const mint = paymentMint.toBase58();
    expect(() => paymentSettings({ STOKED_PAYMENT_MINT: mint })).toThrow(/ESCROW_PROGRAM_ID/);
    expect(() => paymentSettings({ STOKED_PAYMENT_MINT: "nope", ESCROW_PROGRAM_ID: mint })).toThrow(/isn't a Solana address/);
    expect(paymentSettings({ STOKED_PAYMENT_MINT: mint, ESCROW_PROGRAM_ID: mint })).toMatchObject({ symbol: "USDC" });
  });
});
