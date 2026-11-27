/**
 * The API with escrow, on a fake chain (no validator or Rust toolchain). The
 * program's own rules are tested in programs/escrow and test/escrow.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SignedClaim } from "@stoked/chain";
import type { EscrowAdapter, EscrowGiftState } from "@stoked/chain/escrow";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { escrowSettings } from "../../lib/server/env";
import { createRateLimiter } from "../../lib/server/rate-limit";
import { ESCROW_TTL_SECONDS, createGiftService, type ServiceDeps } from "../../lib/server/service";
import { createSqlGiftStore } from "../../lib/server/store-sql";
import { createSupabaseGiftStore } from "../../lib/server/store-supabase";
import { hashToken } from "../../lib/server/tokens";
import { FakeChain, NOW, OTHER_WALLET, VALID_WALLET, freshDb, giftReq } from "./harness";

const NOW_SECONDS = NOW.getTime() / 1000;

interface FakeGift extends EscrowGiftState {
  giftId: string;
  claimToken: string;
  raw: bigint;
}

/**
 * Stands in for the program: a transaction's effect applies when it lands, and
 * a claim succeeds only on an open gift, inside its window, with its token.
 */
class FakeEscrow implements EscrowAdapter {
  clusterTime = NOW_SECONDS;
  gifts = new Map<string, FakeGift>();
  payouts: { account: string; wallet: string; signature: string }[] = [];
  buildCreateThrows = false;
  readThrows = false;
  private effects = new Map<string, () => boolean>();
  private results = new Map<string, boolean>();

  constructor(readonly chain: FakeChain) {
    const { sendClaim, claimStatus } = {
      sendClaim: chain.sendClaim.bind(chain),
      claimStatus: chain.claimStatus.bind(chain),
    };
    chain.sendClaim = async (tx) => {
      if (!this.effects.has(tx.signature)) return sendClaim(tx);
      chain.beforeSend?.(tx);
      chain.sent.push(tx.signature);
      if (chain.landOnSend) this.land(tx.signature);
    };
    chain.claimStatus = async (signature, lvh) => {
      if (chain.statusThrows || !this.effects.has(signature)) return claimStatus(signature, lvh);
      const ok = this.results.get(signature);
      if (ok !== undefined) return ok ? { state: "confirmed" } : { state: "failed", reason: "program error" };
      return chain.height > lvh ? { state: "expired" } : { state: "pending" };
    };
  }

  private sign(effect: (signature: string) => boolean): SignedClaim {
    const signature = randomUUID().replace(/-/g, "").repeat(3).replace(/0/g, "z").slice(0, 88);
    const lastValidBlockHeight = this.chain.height + this.chain.validFor;
    this.effects.set(signature, () => this.chain.height <= lastValidBlockHeight && effect(signature));
    return { signature, lastValidBlockHeight, transaction: new Uint8Array([2]) };
  }

  land(signature: string) {
    if (!this.results.has(signature)) this.results.set(signature, this.effects.get(signature)!());
    return this.results.get(signature)!;
  }

  async buildCreate(i: Parameters<EscrowAdapter["buildCreate"]>[0]) {
    if (this.buildCreateThrows) throw new Error("RPC unavailable");
    const account = `gift-${i.giftId}`;
    const tx = this.sign(() => {
      this.gifts.set(account, { ...i, status: "open", recipient: null });
      return true;
    });
    return { ...tx, account };
  }

  async buildClaim(i: Parameters<EscrowAdapter["buildClaim"]>[0]) {
    return this.sign((signature) => {
      const g = this.gifts.get(i.account);
      if (!g || g.status !== "open" || g.claimToken !== i.claimToken || g.giftId !== i.giftId) return false;
      if (this.clusterTime < g.openAt || this.clusterTime >= g.expiresAt) return false;
      g.status = "claimed";
      g.recipient = i.recipientWallet;
      this.payouts.push({ account: i.account, wallet: i.recipientWallet, signature });
      return true;
    });
  }

  async read(account: string) {
    if (this.readThrows) throw new Error("RPC unavailable");
    const g = this.gifts.get(account);
    const gift = g ? { status: g.status, recipient: g.recipient, openAt: g.openAt, expiresAt: g.expiresAt } : null;
    return { gift, clusterTime: this.clusterTime };
  }

  async findClaimSignature(account: string) {
    return this.payouts.find((p) => p.account === account)?.signature ?? null;
  }

  only() {
    expect(this.gifts.size).toBe(1);
    return [...this.gifts.values()][0]!;
  }
}

/** Records query arguments. A select returns escrow_account only if it asks for it, as PostgREST would. */
function fakeSupabase(row: Record<string, unknown> | null) {
  const seen: string[] = [];
  const from = () => {
    let cols: string[] = [];
    const rows = () => {
      if (!row) return [];
      const copy = { ...row };
      if (!cols.includes("*") && !cols.includes("escrow_account")) delete copy.escrow_account;
      return [copy];
    };
    const builder: object = new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (done: (v: unknown) => void) => done({ data: rows(), error: null, count: 0 })
            : (...args: unknown[]) => {
                if (name === "select") cols = String(args[0]).split(",");
                seen.push(JSON.stringify(args));
                return builder;
              },
      },
    );
    return builder;
  };
  return { sb: { from } as unknown as SupabaseClient, seen };
}

// One database for the file, emptied per test: starting PGlite is slow.
let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
}, 60_000);

async function withEscrow(createGifts = true) {
  await db.exec("truncate gifts");
  const chain = new FakeChain();
  const store = createSqlGiftStore(db);
  const deps: ServiceDeps = {
    store,
    chain,
    rateLimiter: createRateLimiter({ perKey: 1000, global: 1000, windowMs: 60_000 }),
    now: () => NOW,
    confirmPolls: 1,
    confirmIntervalMs: 0,
  };
  const base = { db, store, chain, deps };
  const escrow = new FakeEscrow(base.chain);
  const serviceWith = (flag: boolean) =>
    createGiftService({ ...base.deps, escrow: { adapter: escrow, createGifts: flag, createConfirmPolls: 3 } });
  return { ...base, escrow, serviceWith, service: serviceWith(createGifts) };
}

type Ctx = Awaited<ReturnType<typeof withEscrow>>;

async function openedGift({ service }: Ctx) {
  const { id, claimToken } = await service.create(giftReq(), "ip");
  await service.open(id, claimToken);
  return { id, token: claimToken };
}

const claim = (c: Ctx, g: { id: string; token: string }, wallet = VALID_WALLET) =>
  c.service.claim(g.id, g.token, { wallet });

const count = async (c: Ctx) => (await c.db.query<{ n: number }>("select count(*)::int as n from gifts")).rows[0]!.n;

describe("escrow flag off (the default)", () => {
  it("creates, swaps and claims through the treasury exactly as before", async () => {
    const c = await withEscrow(false);
    const g = await openedGift(c);
    expect((await c.store.get(g.id))!.escrowAccount).toBeNull();
    await c.service.swap(g.id, g.token, { ticker: "tAAPL" });
    expect(await c.service.get(g.id)).not.toHaveProperty("swappable");
    expect((await claim(c, g)).httpStatus).toBe(200);
    expect(c.chain.transfers).toHaveLength(1);
    expect(c.escrow.gifts.size).toBe(0);
    expect(c.escrow.payouts).toHaveLength(0);
  });

  it("reads settings: off unless STOKED_ESCROW is exactly 1", () => {
    const id = "eXVAv3pDTpMfobKopghfV6BQui7WKx61qcoacRvbtdB";
    expect(escrowSettings({})).toBeUndefined();
    expect(escrowSettings({ STOKED_ESCROW: "" })).toBeUndefined();
    expect(escrowSettings({ STOKED_ESCROW: "true" })).toBeUndefined();
    expect(escrowSettings({ ESCROW_PROGRAM_ID: id })?.createGifts).toBe(false);
    expect(escrowSettings({ ESCROW_PROGRAM_ID: id, STOKED_ESCROW: "1" })?.createGifts).toBe(true);
    expect(() => escrowSettings({ STOKED_ESCROW: "1" })).toThrow(/ESCROW_PROGRAM_ID/);
    expect(() => escrowSettings({ ESCROW_PROGRAM_ID: "nope" })).toThrow(/ESCROW_PROGRAM_ID/);
  });

  it("names the new column to Supabase only when inserting an escrow gift", async () => {
    const { sb, seen } = fakeSupabase(null);
    const store = createSupabaseGiftStore(sb);
    await store.get("id");
    await store.open("id", "t");
    await store.swap("id", { ticker: "tAAPL", priceCents: 1, tokenRaw: "1" });
    await store.beginClaim("id", "w");
    await store.setClaimTx("id", null, "s", 1n);
    await store.markClaimed("id", "s", "t");
    await store.countCreatedSince("t");
    const insert = (g: object) =>
      store.insert(g as Parameters<typeof store.insert>[0]).catch(() => undefined);
    await insert({});
    // So a database without the escrow migration keeps working.
    expect(seen.join("\n")).not.toContain("escrow");
    await insert({ id: "id", escrowAccount: "account" });
    expect(seen.join("\n")).toContain('"escrow_account":"account"');
  });

  it("recognises an escrow gift in Supabase, and won't pay it, with no escrow settings at all", async () => {
    const token = "t".repeat(40);
    const { sb } = fakeSupabase({
      id: "00000000-0000-4000-8000-000000000001",
      status: "opened",
      sender_name: "Alex",
      recipient_name: "Maya",
      ticker: "tNVDA",
      usd_cents: 1000,
      price_cents: 22952,
      token_raw: 4356918,
      token_raw_text: "4356918",
      note: null,
      opens_at: null,
      claim_token_hash: hashToken(token),
      recipient_wallet: null,
      claim_signature: null,
      claim_last_valid_height: null,
      claim_last_valid_height_text: null,
      created_at: NOW.toISOString(),
      opened_at: NOW.toISOString(),
      claimed_at: null,
      escrow_account: "account",
    });
    const chain = new FakeChain();
    const service = createGiftService({
      store: createSupabaseGiftStore(sb),
      chain,
      rateLimiter: createRateLimiter({ perKey: 10, global: 10, windowMs: 60_000 }),
      now: () => NOW,
    });
    const id = "00000000-0000-4000-8000-000000000001";
    await expect(service.claim(id, token, { wallet: VALID_WALLET })).rejects.toMatchObject({ code: "internal" });
    await expect(service.swap(id, token, { ticker: "tAAPL" })).rejects.toMatchObject({ code: "invalid_state" });
    expect(chain.transfers).toHaveLength(0);
  });
});

describe("escrow flag on", () => {
  it("locks the tokens at creation, with the open and expiry times, and stores only the token hash", async () => {
    const c = await withEscrow();
    const { id, claimToken } = await c.service.create(giftReq(), "ip");
    const row = (await c.store.get(id))!;
    expect(row.escrowAccount).toBe(`gift-${id}`);
    expect(row.claimTokenHash).toBe(hashToken(claimToken));
    expect(JSON.stringify((await c.db.query("select * from gifts")).rows)).not.toContain(claimToken);
    expect(c.escrow.only()).toMatchObject({
      status: "open",
      giftId: id,
      claimToken,
      raw: BigInt(row.tokenRaw),
      openAt: 0,
      expiresAt: NOW_SECONDS + ESCROW_TTL_SECONDS,
    });
    expect(c.chain.transfers).toHaveLength(0);
    expect((await c.service.get(id)).status).toBe("wrapped");
  });

  it("rounds opensAt up to a second, counts expiry from it, and caps how far ahead it can be", async () => {
    const c = await withEscrow();
    await c.service.create(giftReq({ opensAt: "2026-12-01T00:00:00.250Z" }), "ip");
    const openAt = Date.parse("2026-12-01T00:00:01Z") / 1000;
    expect(c.escrow.only()).toMatchObject({ openAt, expiresAt: openAt + ESCROW_TTL_SECONDS });
    const far = giftReq({ opensAt: "2028-01-01T00:00:00Z" });
    await expect(c.service.create(far, "ip")).rejects.toMatchObject({ code: "validation_failed" });
    expect(await count(c)).toBe(1);
    // Without escrow nothing is locked, so the limit doesn't apply.
    await expect(c.serviceWith(false).create(far, "ip")).resolves.toBeDefined();
  });

  it("returns no link unless the lock is confirmed", async () => {
    const c = await withEscrow();
    const refused = { code: "chain_unavailable" };
    c.escrow.buildCreateThrows = true;
    await expect(c.service.create(giftReq(), "ip")).rejects.toMatchObject(refused);
    expect(await count(c)).toBe(0);
    c.escrow.buildCreateThrows = false;
    c.chain.landOnSend = false;
    await expect(c.service.create(giftReq(), "ip")).rejects.toMatchObject(refused);
    c.chain.landOnSend = true;
    c.chain.beforeSend = () => {
      throw new Error("send failed");
    };
    await expect(c.service.create(giftReq(), "ip")).rejects.toMatchObject(refused);
    expect(c.escrow.gifts.size).toBe(0);
  });

  it("gives up on an unconfirmed lock when its time is up, however slow the RPC", async () => {
    const c = await withEscrow();
    const quick = createGiftService({
      ...c.deps,
      confirmIntervalMs: 5,
      escrow: { adapter: c.escrow, createGifts: true, createTimeoutMs: 200 },
    });
    const gaveUp = async () => {
      const started = Date.now();
      await expect(quick.create(giftReq(), "ip")).rejects.toMatchObject({ code: "chain_unavailable" });
      expect(Date.now() - started).toBeLessThan(2_000);
    };
    c.chain.landOnSend = false; // always pending
    await gaveUp();
    c.chain.claimStatus = () => new Promise(() => undefined); // a status call that never returns
    await gaveUp();
    c.chain.sendClaim = () => new Promise(() => undefined);
    await gaveUp();
  });

  it("refuses a swap, leaving the gift as locked", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    await expect(c.service.swap(g.id, g.token, { ticker: "tAAPL" })).rejects.toMatchObject({ code: "invalid_state" });
    expect((await c.store.get(g.id))!.ticker).toBe("tNVDA");
    expect(await c.service.get(g.id)).toMatchObject({ status: "opened", swappable: false });
  });

  it("claims through the program, never the treasury, and only once", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    const first = await claim(c, g);
    expect(first.httpStatus).toBe(200);
    expect((await claim(c, g)).body.signature).toBe(first.body.signature);
    await expect(claim(c, g, OTHER_WALLET)).rejects.toMatchObject({ code: "invalid_state" });
    expect(c.escrow.payouts).toEqual([
      { account: `gift-${g.id}`, wallet: VALID_WALLET, signature: first.body.signature },
    ]);
    expect(c.chain.transfers).toHaveLength(0);
  });

  it("pays once under 20 concurrent claims", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    await Promise.all(Array.from({ length: 20 }, () => claim(c, g).catch(() => undefined)));
    expect((await claim(c, g)).httpStatus).toBe(200);
    expect(c.escrow.payouts).toHaveLength(1);
  });

  it("recovers from a crash after signing but before sending, once the blockhash expires", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    c.chain.beforeSend = () => {
      throw new Error("crash");
    };
    expect((await claim(c, g)).httpStatus).toBe(202);
    const lost = (await c.store.get(g.id))!.claimSignature!;
    c.chain.beforeSend = undefined;
    expect((await claim(c, g)).body.signature).toBe(lost);
    expect(c.escrow.payouts).toHaveLength(0);
    c.chain.advance(c.chain.validFor + 1n);
    expect((await claim(c, g)).httpStatus).toBe(200);
    expect(c.escrow.land(lost)).toBe(false);
    expect(c.escrow.payouts).toHaveLength(1);
  });

  it("recovers from a crash after sending but before confirming", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    c.chain.statusThrows = true;
    expect((await claim(c, g)).httpStatus).toBe(202);
    c.chain.statusThrows = false;
    expect((await claim(c, g)).httpStatus).toBe(200);
    expect(c.escrow.payouts).toHaveLength(1);
  });

  it("records the transaction that actually paid when the stored one didn't", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    c.chain.landOnSend = false;
    expect((await claim(c, g)).httpStatus).toBe(202);
    const stored = (await c.store.get(g.id))!.claimSignature!;
    // Another transaction to the same wallet lands, then the stored one expires.
    const other = await c.escrow.buildClaim({
      account: `gift-${g.id}`,
      giftId: g.id,
      claimToken: g.token,
      recipientWallet: VALID_WALLET,
    });
    expect(c.escrow.land(other.signature)).toBe(true);
    c.chain.advance(c.chain.validFor + 1n);
    const done = await claim(c, g);
    expect(done.httpStatus).toBe(200);
    expect(done.body.signature).toBe(other.signature);
    expect(done.body.signature).not.toBe(stored);
    expect(c.escrow.payouts).toHaveLength(1);
  });

  it("binds no wallet while the cluster says it's too early, expired, refunded or unreadable", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    const chainGift = c.escrow.only();
    const refused = async (code: string) => {
      await expect(claim(c, g)).rejects.toMatchObject({ code });
      expect(await c.store.get(g.id)).toMatchObject({ status: "opened", recipientWallet: null });
    };
    chainGift.openAt = NOW_SECONDS + 1;
    await refused("too_early");
    chainGift.openAt = 0;
    c.escrow.clusterTime = chainGift.expiresAt;
    await refused("expired");
    c.escrow.clusterTime = NOW_SECONDS;
    chainGift.status = "refunded";
    await refused("expired");
    chainGift.status = "claimed";
    chainGift.recipient = OTHER_WALLET;
    await refused("invalid_state");
    chainGift.status = "open";
    chainGift.recipient = null;
    c.escrow.readThrows = true;
    await refused("chain_unavailable");
    c.escrow.readThrows = false;
    c.escrow.gifts.clear();
    await refused("chain_unavailable");
    expect(c.escrow.payouts).toHaveLength(0);
    expect(c.chain.transfers).toHaveLength(0);
  });

  it("doesn't rebuild a claim for a gift that expired while claiming", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    c.chain.landOnSend = false;
    await claim(c, g);
    c.escrow.clusterTime = c.escrow.only().expiresAt;
    c.chain.advance(c.chain.validFor + 1n);
    const sent = c.chain.sent.length;
    await expect(claim(c, g)).rejects.toMatchObject({ code: "expired" });
    expect(c.chain.sent).toHaveLength(sent);
  });
});

describe("the mode is fixed per gift", () => {
  it("claims an escrow gift through the program after the flag is turned off", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    const off = { ...c, service: c.serviceWith(false) };
    await expect(off.service.swap(g.id, g.token, { ticker: "tAAPL" })).rejects.toMatchObject({ code: "invalid_state" });
    expect((await claim(off, g)).httpStatus).toBe(200);
    expect(c.escrow.payouts).toHaveLength(1);
    expect(c.chain.transfers).toHaveLength(0);
  });

  it("claims a treasury gift from the treasury after the flag is turned on", async () => {
    const c = await withEscrow(false);
    const g = await openedGift(c);
    const on = { ...c, service: c.serviceWith(true) };
    expect((await claim(on, g)).httpStatus).toBe(200);
    expect(c.chain.transfers).toHaveLength(1);
    expect(c.escrow.payouts).toHaveLength(0);
  });

  it("refuses an escrow gift, rather than paying from the treasury, when escrow isn't configured", async () => {
    const c = await withEscrow();
    const g = await openedGift(c);
    const bare = { ...c, service: createGiftService(c.deps) };
    await expect(claim(bare, g)).rejects.toMatchObject({ code: "internal" });
    expect((await c.store.get(g.id))!.status).toBe("opened");
    expect(c.chain.transfers).toHaveLength(0);
  });
});
