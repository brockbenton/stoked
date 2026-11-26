import { fixtures, PublicGift } from "@stoked/shared";
import { describe, expect, it } from "vitest";
import { createFixtureClient, parseSim } from "../lib/client/fixture";
import { readTokenFromHash } from "../lib/client";
import { isLivePrice } from "../lib/format";

const T = "token-token-token-token-token-token";
const fast = (extra: Parameters<typeof createFixtureClient>[0] = {}) =>
  createFixtureClient({ latencyMs: 0, now: () => Date.parse("2026-11-28T15:10:00Z"), ...extra });

describe("fixture client", () => {
  it("returns public shapes that match the shared schema", async () => {
    const c = fast();
    for (const g of Object.values(fixtures)) {
      PublicGift.parse(await c.getGift(g.id));
    }
  });

  it("a wrapped gift hides ticker, amount and note until opened", async () => {
    const c = fast();
    const wrapped = await c.getGift(fixtures.wrapped.id);
    expect(wrapped).not.toHaveProperty("ticker");
    expect(wrapped).not.toHaveProperty("usdCents");
    expect(wrapped).not.toHaveProperty("note");
    const opened = await c.openGift(fixtures.wrapped.id, T);
    expect(opened.status).toBe("opened");
    if (opened.status === "opened") expect(opened.value.shares).toBe("0.0436");
  });

  it("create → open → swap keeps the USD value → claim lands after polling", async () => {
    const c = fast();
    const { id, claimToken } = await c.createGift({
      senderName: "Sam",
      recipientName: "Maya",
      ticker: "tNVDA",
      usdCents: 2500,
    });
    expect(claimToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    await c.openGift(id, claimToken);
    const swapped = await c.swapGift(id, claimToken, "tAAPL");
    expect(swapped.status === "opened" && swapped.usdCents).toBe(2500);
    expect(swapped.status === "opened" && swapped.ticker).toBe("tAAPL");
    const first = await c.claimGift(id, claimToken, "Wallet111111111111111111111111111111111111");
    expect(first.status).toBe("pending");
    await c.getGift(id);
    expect((await c.getGift(id)).status).toBe("claimed");
    await expect(c.swapGift(id, claimToken, "tSPY")).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("refuses to open before opensAt, and without a token", async () => {
    const c = fast();
    await expect(c.openGift(fixtures.wrappedScheduled.id, T)).rejects.toMatchObject({ code: "too_early" });
    await expect(c.openGift(fixtures.wrapped.id, "")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("unknown id is not_found; sims fail claims and go offline", async () => {
    await expect(fast().getGift("nope")).rejects.toMatchObject({ code: "not_found" });
    const failing = fast({ sim: new Set(["claim-fail"]) });
    await expect(failing.claimGift(fixtures.opened.id, T, "w")).rejects.toMatchObject({ code: "chain_unavailable" });
    await expect(fast({ sim: new Set(["offline"]) }).getGift(fixtures.wrapped.id)).rejects.toMatchObject({
      code: "offline",
    });
  });
});

describe("helpers", () => {
  it("reads the token from the fragment only", () => {
    expect(readTokenFromHash("#t=abc")).toBe("abc");
    expect(readTokenFromHash("")).toBe("");
  });
  it("parses sim flags", () => {
    expect([...parseSim("?sim=offline,claim-fail&sim=bogus")].sort()).toEqual(["claim-fail", "offline"]);
  });
  it("calls a price Live only when fresh and not a demo price", () => {
    const now = Date.parse("2026-11-28T15:00:00Z");
    expect(isLivePrice({ priceSource: "Demo price (not live)", priceUpdatedAt: "2026-11-28T15:00:00Z" }, now)).toBe(false);
    expect(isLivePrice({ priceSource: "Feed", priceUpdatedAt: "2026-11-28T14:58:00Z" }, now)).toBe(true);
    expect(isLivePrice({ priceSource: "Feed", priceUpdatedAt: "2026-11-28T14:50:00Z" }, now)).toBe(false);
  });
});
