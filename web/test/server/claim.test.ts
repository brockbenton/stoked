/**
 * Claim must never pay twice (docs/build-plan.md). Service level, PGlite with
 * the real migration, fake chain that lands each signature at most once and
 * only before its last valid block height.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { GiftStore } from "../../lib/server/store";
import { createGiftService } from "../../lib/server/service";
import { OTHER_WALLET, VALID_WALLET, giftReq, setup } from "./harness";

type Ctx = Awaited<ReturnType<typeof setup>>;
const open: Ctx[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.db.close();
});

async function openedGift(over: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(over);
  open.push(ctx);
  const { id, claimToken } = await ctx.service.create(giftReq(), "test");
  await ctx.service.open(id, claimToken);
  return { ...ctx, id, token: claimToken };
}

class Crash extends Error {
  constructor(where: string) {
    super(`simulated crash ${where}`);
  }
}

/** Wrap a store so one method throws once, after (or before) the real call. */
function crashOnce<K extends keyof GiftStore>(store: GiftStore, method: K, when: "after" | "before"): GiftStore {
  let crashed = false;
  const orig = store[method] as (...a: unknown[]) => Promise<unknown>;
  return {
    ...store,
    [method]: async (...args: unknown[]) => {
      if (!crashed && when === "before") {
        crashed = true;
        throw new Crash(`before ${method}`);
      }
      const r = await orig.apply(store, args);
      if (!crashed && when === "after" && r) {
        crashed = true;
        throw new Crash(`after ${method}`);
      }
      return r;
    },
  };
}

async function row(ctx: Ctx, id: string) {
  const { rows } = await ctx.db.query<{ status: string; claim_signature: string | null; recipient_wallet: string | null }>(
    "select status, claim_signature, recipient_wallet from gifts where id = $1",
    [id],
  );
  return rows[0]!;
}

describe("claim safety", () => {
  it("20 concurrent claims produce exactly one transfer", async () => {
    const g = await openedGift();
    g.chain.buildJitterMs = 10; // interleave the 20 requests between reading state and storing a signature
    g.chain.landOnSend = false; // keep everything in flight during the race...
    const results = await Promise.all(Array.from({ length: 20 }, () => g.service.claim(g.id, g.token, { wallet: VALID_WALLET })));
    for (const sig of g.chain.sent) g.chain.land(sig); // ...then let every broadcast land
    g.chain.landOnSend = true;
    expect(g.chain.built.length).toBeGreaterThan(1); // the race really happened
    expect(g.chain.transfers).toHaveLength(1);
    expect(g.chain.transfers[0]).toMatchObject({ wallet: VALID_WALLET, raw: 4356918n });
    expect(g.chain.sent).toHaveLength(1); // only the stored transaction was ever broadcast
    for (const r of results) expect([200, 202]).toContain(r.httpStatus);
    // Whoever lost now sees it claimed.
    const after = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(after.httpStatus).toBe(200);
    expect((await row(g, g.id)).status).toBe("claimed");
  });

  it("crash after signing but before send: retries wait, then replace the expired transaction once", async () => {
    const base = await openedGift();
    // Signature stored (step 3), then the process dies before sending (step 4).
    const g = { ...base, service: createGiftService({ ...base.deps, store: crashOnce(base.store, "setClaimTx", "after") }) };
    await expect(g.service.claim(g.id, g.token, { wallet: VALID_WALLET })).rejects.toBeInstanceOf(Crash);
    const stuck = await row(g, g.id);
    expect(stuck.status).toBe("claiming");
    expect(stuck.claim_signature).toBe(g.chain.built[0]!.signature);
    expect(g.chain.sent).toHaveLength(0);

    // Retry before the blockhash expires: it might still land, so 202 and no new transaction.
    const early = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(early.httpStatus).toBe(202);
    expect(g.chain.built).toHaveLength(1);

    // Past the last valid height: replaced once, sent, confirmed.
    g.chain.advance(151);
    const done = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(done.httpStatus).toBe(200);
    expect(g.chain.built).toHaveLength(2);
    expect(done.body.signature).toBe(g.chain.built[1]!.signature);
    // The first transaction can never land now.
    expect(g.chain.land(g.chain.built[0]!.signature)).toBe(false);
    expect(g.chain.transfers).toHaveLength(1);
  });

  it("crash after send but before confirm: a retry finds it confirmed and pays nothing more", async () => {
    const base = await openedGift();
    const g = { ...base, service: createGiftService({ ...base.deps, store: crashOnce(base.store, "markClaimed", "before") }) };
    await expect(g.service.claim(g.id, g.token, { wallet: VALID_WALLET })).rejects.toBeInstanceOf(Crash);
    expect(g.chain.transfers).toHaveLength(1); // it landed
    expect((await row(g, g.id)).status).toBe("claiming");

    g.chain.advance(1000); // far past its height: must still not be replaced
    const r = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(r.httpStatus).toBe(200);
    expect(r.body.signature).toBe(g.chain.built[0]!.signature);
    expect(g.chain.built).toHaveLength(1);
    expect(g.chain.transfers).toHaveLength(1);
  });

  it("crash after send where the broadcast lands late: still one transfer", async () => {
    const g = await openedGift();
    g.chain.landOnSend = false; // in flight
    const first = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(first.httpStatus).toBe(202);
    const sig = g.chain.built[0]!.signature;
    expect(g.chain.land(sig)).toBe(true); // lands before expiry
    g.chain.landOnSend = true;
    g.chain.advance(500);
    const r = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(r.httpStatus).toBe(200);
    expect(r.body.signature).toBe(sig);
    expect(g.chain.transfers).toHaveLength(1);
  });

  it("a retry with a different wallet does not redirect funds", async () => {
    const g = await openedGift();
    g.chain.landOnSend = false;
    expect((await g.service.claim(g.id, g.token, { wallet: VALID_WALLET })).httpStatus).toBe(202);
    await expect(g.service.claim(g.id, g.token, { wallet: OTHER_WALLET })).rejects.toMatchObject({
      code: "invalid_state",
      status: 409,
    });
    // Even after expiry, the replacement goes to the original wallet.
    g.chain.landOnSend = true;
    g.chain.advance(151);
    await expect(g.service.claim(g.id, g.token, { wallet: OTHER_WALLET })).rejects.toMatchObject({ code: "invalid_state" });
    const r = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(r.httpStatus).toBe(200);
    expect(g.chain.transfers.map((t) => t.wallet)).toEqual([VALID_WALLET]);
    expect((await row(g, g.id)).recipient_wallet).toBe(VALID_WALLET);
  });

  it("an expired transaction is replaced exactly once under concurrent retries", async () => {
    const g = await openedGift();
    g.chain.landOnSend = false;
    await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    const firstSig = g.chain.built[0]!.signature;
    g.chain.advance(151); // expired, never landed
    g.chain.landOnSend = true;

    let replacements = 0;
    const counting: GiftStore = {
      ...g.store,
      setClaimTx: async (...a) => {
        const r = await g.store.setClaimTx(...a);
        if (r && a[1] === firstSig) replacements += 1;
        return r;
      },
    };
    const svc = createGiftService({ ...g.deps, store: counting });
    const results = await Promise.all(Array.from({ length: 12 }, () => svc.claim(g.id, g.token, { wallet: VALID_WALLET })));
    expect(replacements).toBe(1);
    expect(g.chain.sent.filter((s) => s !== firstSig)).toHaveLength(1); // one replacement broadcast
    expect(g.chain.transfers).toHaveLength(1);
    for (const r of results) expect([200, 202]).toContain(r.httpStatus);
    expect((await row(g, g.id)).status).toBe("claimed");
  });

  it("a confirmed transaction is never replaced, however late the retry", async () => {
    const g = await openedGift();
    g.chain.landOnSend = false;
    await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    const sig = g.chain.built[0]!.signature;
    g.chain.land(sig);
    g.chain.advance(10_000);
    for (let i = 0; i < 3; i++) {
      const r = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
      expect(r.httpStatus).toBe(200);
      expect(r.body.signature).toBe(sig);
    }
    expect(g.chain.built).toHaveLength(1);
    expect((await row(g, g.id)).claim_signature).toBe(sig);
    expect(g.chain.transfers).toHaveLength(1);
  });

  it("a transaction that landed with an error moved nothing and is replaced once", async () => {
    const g = await openedGift();
    g.chain.landOnSend = false;
    await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    const first = g.chain.built[0]!.signature;
    g.chain.landFailed(first);
    g.chain.landOnSend = true;
    const r = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(r.httpStatus).toBe(200);
    expect(g.chain.built).toHaveLength(2);
    expect(r.body.signature).not.toBe(first);
    expect(g.chain.transfers).toHaveLength(1);
  });

  it("an unknown status (RPC down) past the height is never treated as expired", async () => {
    const g = await openedGift();
    g.chain.landOnSend = false;
    await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    g.chain.advance(10_000);
    g.chain.statusThrows = true;
    const r = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(r.httpStatus).toBe(202);
    expect(g.chain.built).toHaveLength(1);
    expect((await row(g, g.id)).claim_signature).toBe(g.chain.built[0]!.signature);
  });

  it("concurrent first claims to two different wallets bind exactly one wallet", async () => {
    const g = await openedGift();
    g.chain.buildJitterMs = 5;
    const attempts = Array.from({ length: 10 }, (_, i) => (i % 2 ? OTHER_WALLET : VALID_WALLET));
    const results = await Promise.allSettled(attempts.map((wallet) => g.service.claim(g.id, g.token, { wallet })));
    const bound = (await row(g, g.id)).recipient_wallet!;
    expect([VALID_WALLET, OTHER_WALLET]).toContain(bound);
    results.forEach((r, i) => {
      if (attempts[i] === bound) expect(r.status).toBe("fulfilled");
      else expect(r).toMatchObject({ status: "rejected", reason: { code: "invalid_state" } });
    });
    expect(g.chain.transfers.map((t) => t.wallet)).toEqual([bound]);
  });

  it("a request that loses the race after the gift is claimed gets 200 claimed, not 202", async () => {
    const g = await openedGift();
    g.chain.landOnSend = false;
    await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    const sig = g.chain.built[0]!.signature;
    g.chain.land(sig);
    // Another request settles it between our read and our markClaimed.
    const racing: GiftStore = {
      ...g.store,
      markClaimed: async (id, s, at) => {
        await g.store.markClaimed(id, s, at);
        return null;
      },
    };
    const r = await createGiftService({ ...g.deps, store: racing }).claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(r.httpStatus).toBe(200);
    expect(r.body.status).toBe("claimed");
    expect(r.body.gift.status).toBe("claimed");
  });

  it("a send failure leaves the stored transaction to be retried, not doubled", async () => {
    const g = await openedGift();
    let fails = 1;
    g.chain.beforeSend = () => {
      if (fails-- > 0) throw new Error("RPC unavailable");
    };
    const r1 = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(r1.httpStatus).toBe(202);
    expect(g.chain.transfers).toHaveLength(0);
    g.chain.advance(151);
    const r2 = await g.service.claim(g.id, g.token, { wallet: VALID_WALLET });
    expect(r2.httpStatus).toBe(200);
    expect(g.chain.transfers).toHaveLength(1);
  });
});
