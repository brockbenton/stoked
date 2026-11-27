/**
 * The 1:1 API through its route handlers, with PGlite (real migration) and a
 * fake chain injected.
 */
import { PublicKey } from "@solana/web3.js";
import { ApiError as ApiErrorSchema, ClaimGiftResponse, CreateGiftResponse, PublicGift } from "@stoked/shared";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as claimPOST } from "../../app/api/gifts/[id]/claim/route";
import { POST as openPOST } from "../../app/api/gifts/[id]/open/route";
import { GET as giftGET } from "../../app/api/gifts/[id]/route";
import { POST as swapPOST } from "../../app/api/gifts/[id]/swap/route";
import { POST as createPOST } from "../../app/api/gifts/route";
import { setServiceForTests } from "../../lib/server/env";
import { createRateLimiter } from "../../lib/server/rate-limit";
import { createGiftService } from "../../lib/server/service";
import { NOW, OTHER_WALLET, VALID_WALLET, giftReq, setup } from "./harness";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body?: unknown, token?: string | null, headers: Record<string, string> = {}) =>
  new Request("http://test.local/api", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function call(res: Promise<Response>) {
  const r = await res;
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function create(over: Record<string, unknown> = {}) {
  const { status, body } = await call(createPOST(req(giftReq(over))));
  expect(status).toBe(200);
  return CreateGiftResponse.parse(body);
}
const get = (id: string) => call(giftGET(new Request("http://test.local"), params(id)));
const open = (id: string, token?: string | null) => call(openPOST(req(undefined, token), params(id)));
const swap = (id: string, token: string, ticker: string) => call(swapPOST(req({ ticker }, token), params(id)));
const claim = (id: string, token: string | null, wallet: unknown = VALID_WALLET) =>
  call(claimPOST(req({ wallet }, token), params(id)));

async function dbStatus(id: string) {
  const { rows } = await ctx.db.query<{ status: string }>("select status from gifts where id = $1", [id]);
  return rows[0]?.status;
}

function expectError(r: { status: number; body: unknown }, status: number, code: string) {
  expect(r.status).toBe(status);
  const parsed = ApiErrorSchema.parse(r.body);
  expect(parsed.error.code).toBe(code);
}

beforeEach(async () => {
  ctx = await setup();
  setServiceForTests(ctx.service);
});
afterEach(async () => {
  setServiceForTests(undefined);
  await ctx.db.close();
});

describe("status transitions", () => {
  it("wrapped → opened → claiming → claimed, each via its route", async () => {
    const { id, claimToken } = await create();
    expect(await dbStatus(id)).toBe("wrapped");
    expect((await open(id, claimToken)).status).toBe(200);
    expect(await dbStatus(id)).toBe("opened");
    ctx.chain.landOnSend = false;
    const pending = await claim(id, claimToken);
    expect(pending.status).toBe(202);
    expect(await dbStatus(id)).toBe("claiming");
    ctx.chain.land(ctx.chain.sent[0]!);
    const done = await claim(id, claimToken);
    expect(done.status).toBe(200);
    expect(ClaimGiftResponse.parse(done.body).status).toBe("claimed");
    expect(await dbStatus(id)).toBe("claimed");
  });

  it("illegal transitions are refused with 409 invalid_state and change nothing", async () => {
    const { id, claimToken } = await create();
    // wrapped: can't swap or claim
    expectError(await swap(id, claimToken, "tAAPL"), 409, "invalid_state");
    expectError(await claim(id, claimToken), 409, "invalid_state");
    expect(await dbStatus(id)).toBe("wrapped");
    // opened: can't open again
    await open(id, claimToken);
    expectError(await open(id, claimToken), 409, "invalid_state");
    // claiming: can't open or swap
    ctx.chain.landOnSend = false;
    await claim(id, claimToken);
    expect(await dbStatus(id)).toBe("claiming");
    expectError(await open(id, claimToken), 409, "invalid_state");
    expectError(await swap(id, claimToken, "tAAPL"), 409, "invalid_state");
    // claimed: can't open or swap
    ctx.chain.land(ctx.chain.sent[0]!);
    await claim(id, claimToken);
    expect(await dbStatus(id)).toBe("claimed");
    expectError(await open(id, claimToken), 409, "invalid_state");
    expectError(await swap(id, claimToken, "tAAPL"), 409, "invalid_state");
    expect(await dbStatus(id)).toBe("claimed");
  });
});

describe("public state", () => {
  it("a wrapped gift's response contains no ticker, amount or note", async () => {
    const { id } = await create({ note: "secret note" });
    const r = await get(id);
    expect(r.status).toBe(200);
    expect(PublicGift.parse(r.body).status).toBe("wrapped");
    expect(Object.keys(r.body).sort()).toEqual(["createdAt", "id", "opensAt", "recipientName", "senderName", "status"]);
    const text = JSON.stringify(r.body);
    for (const leak of ["tNVDA", "NVDA", "secret note", "usdCents", "ticker", "note", "tokenRaw", "value"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("after opening it shows contents and value with price source and age", async () => {
    const { id, claimToken } = await create();
    await open(id, claimToken);
    const g = PublicGift.parse((await get(id)).body);
    expect(g.status).toBe("opened");
    if (g.status !== "opened") return;
    expect(g.ticker).toBe("tNVDA");
    expect(g.tokenRaw).toBe("4356918");
    expect(g.value).toMatchObject({ shares: "0.0436", multiplier: "1", priceSource: "Demo price (not live)" });
  });

  it("unknown or malformed ids are 404", async () => {
    expectError(await get("00000000-0000-4000-8000-000000000000"), 404, "not_found");
    expectError(await get("not-a-uuid"), 404, "not_found");
  });
});

describe("tokens", () => {
  it("only the token hash is stored", async () => {
    const { id, claimToken } = await create();
    const { rows } = await ctx.db.query<Record<string, unknown>>("select * from gifts where id = $1", [id]);
    const row = rows[0]!;
    expect(row.claim_token_hash).toBe(createHash("sha256").update(claimToken).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(claimToken);
  });

  it("missing token is 401, wrong token is 403, for open, swap and claim", async () => {
    const { id, claimToken } = await create();
    const other = await create();
    expectError(await open(id, null), 401, "unauthorized");
    expectError(await open(id, other.claimToken), 403, "forbidden");
    expectError(await open(id, "x".repeat(43)), 403, "forbidden");
    await open(id, claimToken);
    expectError(await call(swapPOST(req({ ticker: "tAAPL" }), params(id))), 401, "unauthorized");
    expectError(await swap(id, other.claimToken, "tAAPL"), 403, "forbidden");
    expectError(await claim(id, null), 401, "unauthorized");
    expectError(await claim(id, other.claimToken), 403, "forbidden");
    expect(await dbStatus(id)).toBe("opened");
    expect(ctx.chain.built).toHaveLength(0);
  });
});

describe("too_early", () => {
  it("uses the server clock, not anything the client sends", async () => {
    const opensAt = new Date(NOW.getTime() + 3600_000).toISOString();
    const { id, claimToken } = await create({ opensAt });
    // A client-sent Date header claiming it's later changes nothing.
    const early = await call(
      openPOST(req(undefined, claimToken, { date: new Date(NOW.getTime() + 7200_000).toUTCString() }), params(id)),
    );
    expectError(early, 425, "too_early");
    expect(await dbStatus(id)).toBe("wrapped");
    ctx.clock.set(new Date(NOW.getTime() + 3600_000)); // inclusive
    expect((await open(id, claimToken)).status).toBe(200);
  });

  it("refuses an opensAt in the past at creation", async () => {
    const r = await call(createPOST(req(giftReq({ opensAt: new Date(NOW.getTime() - 1000).toISOString() }))));
    expectError(r, 400, "validation_failed");
  });
});

describe("swap", () => {
  it("keeps the USD value, re-sizes raw at the new price, and is refused after claim", async () => {
    const { id, claimToken } = await create({ usdCents: 2500 });
    await open(id, claimToken);
    const r = await swap(id, claimToken, "tAAPL");
    expect(r.status).toBe(200);
    const g = PublicGift.parse(r.body);
    if (g.status !== "opened") throw new Error("expected opened");
    expect(g.ticker).toBe("tAAPL");
    expect(g.usdCents).toBe(2500);
    expect(g.tokenRaw).toBe(((2500n * 10n ** 8n) / 27810n).toString()); // demo AAPL price
    expect(g.value.valueCents).toBe(2500);
    await claim(id, claimToken);
    expect(await dbStatus(id)).toBe("claimed");
    expectError(await swap(id, claimToken, "tSPY"), 409, "invalid_state");
    expect(ctx.chain.transfers).toEqual([expect.objectContaining({ ticker: "tAAPL", raw: BigInt(g.tokenRaw) })]);
  });

  it("rejects an unknown ticker", async () => {
    const { id, claimToken } = await create();
    await open(id, claimToken);
    expectError(await swap(id, claimToken, "tDOGE"), 400, "validation_failed");
  });
});

describe("invalid wallet", () => {
  it("rejects malformed and off-curve (PDA) addresses before binding anything", async () => {
    const { id, claimToken } = await create();
    await open(id, claimToken);
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("x")], new PublicKey(VALID_WALLET));
    for (const w of ["not-a-wallet", "0OIl" + "1".repeat(40), pda.toBase58(), 42]) {
      expectError(await claim(id, claimToken, w), 400, "invalid_wallet");
    }
    expectError(await call(claimPOST(req({}, claimToken), params(id))), 400, "validation_failed");
    expect(await dbStatus(id)).toBe("opened");
    expect(ctx.chain.built).toHaveLength(0);
  });
});

describe("request handling", () => {
  it("bad JSON is 400 bad_request; invalid create bodies are 400 validation_failed", async () => {
    const bad = new Request("http://test.local/api", { method: "POST", body: "{nope" });
    expectError(await call(createPOST(bad)), 400, "bad_request");
    expectError(await call(createPOST(req(giftReq({ usdCents: 999 })))), 400, "validation_failed");
    expectError(await call(createPOST(req({ ...giftReq(), extra: 1 }))), 400, "validation_failed");
  });

  it("rate-limits creation per client", async () => {
    await ctx.db.close();
    ctx = await setup({ rateLimiter: createRateLimiter({ perKey: 2, global: 100, windowMs: 60_000 }) });
    setServiceForTests(ctx.service);
    const ip = { "x-forwarded-for": "203.0.113.7" };
    expect((await call(createPOST(req(giftReq(), null, ip)))).status).toBe(200);
    expect((await call(createPOST(req(giftReq(), null, ip)))).status).toBe(200);
    expectError(await call(createPOST(req(giftReq(), null, ip))), 429, "rate_limited");
    expect((await call(createPOST(req(giftReq(), null, { "x-forwarded-for": "198.51.100.1" })))).status).toBe(200);
  });

  it("request bodies are strict: unknown keys are 400 validation_failed", async () => {
    const { id, claimToken } = await create();
    expectError(await call(openPOST(req({ now: "2030-01-01T00:00:00Z" }, claimToken), params(id))), 400, "validation_failed");
    await open(id, claimToken);
    expectError(await call(swapPOST(req({ ticker: "tAAPL", x: 1 }, claimToken), params(id))), 400, "validation_failed");
    expectError(await call(claimPOST(req({ wallet: VALID_WALLET, extra: 1 }, claimToken), params(id))), 400, "validation_failed");
    expect(await dbStatus(id)).toBe("opened");
  });

  it("caps creation durably across limiter instances (counted in the database)", async () => {
    await ctx.db.close();
    ctx = await setup({ creationCap: { max: 2, windowMs: 3_600_000 } });
    setServiceForTests(ctx.service);
    await create();
    // A second service on the same database (another instance, fresh in-memory limiter).
    setServiceForTests(createGiftService({ ...ctx.deps, rateLimiter: createRateLimiter({ perKey: 9, global: 9, windowMs: 1 }) }));
    await create();
    expectError(await call(createPOST(req(giftReq()))), 429, "rate_limited");
    ctx.clock.set(new Date(NOW.getTime() + 3_600_001)); // window passes
    expect((await call(createPOST(req(giftReq())))).status).toBe(200);
  });

  it("RPC failures are 503 with a generic message, and never break reads of a settled gift", async () => {
    const { id, claimToken } = await create();
    await open(id, claimToken);
    await claim(id, claimToken);
    ctx.chain.multiplierSchedule = async () => {
      throw new Error("fetch failed: https://rpc.example/?api-key=zq9marker");
    };
    const r = await get(id);
    expect(r.status).toBe(200);
    expect(PublicGift.parse(r.body).status).toBe("claimed");
    const c = await call(createPOST(req(giftReq())));
    expectError(c, 503, "chain_unavailable");
    expect(JSON.stringify(c.body)).not.toContain("zq9marker");
  });

  it("a claim for a claimed gift by its wallet is 200 again; another wallet is 409", async () => {
    const { id, claimToken } = await create();
    await open(id, claimToken);
    const first = await claim(id, claimToken);
    expect(first.status).toBe(200);
    const again = await claim(id, claimToken);
    expect(again.status).toBe(200);
    expect(again.body.signature).toBe(first.body.signature);
    expectError(await claim(id, claimToken, OTHER_WALLET), 409, "invalid_state");
    expect(ctx.chain.transfers).toHaveLength(1);
  });
});
