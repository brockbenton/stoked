import { describe, expect, it } from "vitest";
import { allFixtures, fixtures } from "../src/fixtures";
import {
  ApiError,
  ClaimGiftRequest,
  ClaimGiftResponse,
  CreateContributionRequest,
  CreateContributionResponse,
  CreateGiftRequest,
  CreateGiftResponse,
  CreateGroupRequest,
  ERROR_STATUS,
  GIFT_STATUSES,
  PublicGift,
  PublicSingleWrapped,
  SwapGiftRequest,
} from "../src/schemas";

describe("public schema for a wrapped single gift", () => {
  const wrapped = fixtures.single.wrapped;

  it("accepts the wrapped fixture", () => {
    expect(PublicSingleWrapped.safeParse(wrapped).success).toBe(true);
    expect(PublicGift.safeParse(wrapped).success).toBe(true);
  });

  for (const [key, value] of [
    ["ticker", "NVDA"],
    ["usdCents", 1000],
    ["note", "Happy birthday"],
  ] as const) {
    it(`rejects ${key}`, () => {
      const leaked = { ...wrapped, [key]: value };
      expect(PublicSingleWrapped.safeParse(leaked).success).toBe(false);
      expect(PublicGift.safeParse(leaked).success).toBe(false);
    });

    it(`rejects ${key} even when null`, () => {
      expect(PublicGift.safeParse({ ...wrapped, [key]: null }).success).toBe(false);
    });
  }

  it("rejects the value and raw amount too", () => {
    expect(PublicGift.safeParse({ ...wrapped, tokenRaw: "4356918" }).success).toBe(false);
    expect(PublicGift.safeParse({ ...wrapped, value: fixtures.single.opened.value }).success).toBe(false);
  });
});

describe("fixtures", () => {
  it("cover every status for groups and every reachable status for singles", () => {
    expect(new Set(Object.values(fixtures.group).map((g) => g.status))).toEqual(new Set(GIFT_STATUSES));
    expect(new Set(Object.values(fixtures.single).map((g) => g.status))).toEqual(
      new Set(GIFT_STATUSES.filter((s) => s !== "funding")),
    );
  });

  it.each(allFixtures.map((g) => [`${g.kind} ${g.status} ${g.id}`, g] as const))("%s parses", (_name, gift) => {
    const parsed = PublicGift.safeParse(gift);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it("show the reference share count", () => {
    expect(fixtures.single.opened.status === "opened" && fixtures.single.opened.value.shares).toBe("0.0436");
  });

  it("a single gift cannot be funding", () => {
    expect(PublicGift.safeParse({ ...fixtures.single.wrapped, status: "funding" }).success).toBe(false);
  });

  it("an opened gift requires its contents", () => {
    const { note: _note, ...withoutNote } = fixtures.single.opened as Record<string, unknown>;
    expect(PublicGift.safeParse(withoutNote).success).toBe(false);
  });

  it("a funding group never shows amount or note", () => {
    expect(PublicGift.safeParse({ ...fixtures.group.funding, note: "hi" }).success).toBe(false);
    expect(PublicGift.safeParse({ ...fixtures.group.funding, usdCents: 7500 }).success).toBe(false);
  });
});

describe("requests", () => {
  const gift = { senderName: "Alex", recipientName: "Maya", ticker: "NVDA", usdCents: 1000 };

  it("create gift accepts only 1000, 2500 or 5000 cents", () => {
    for (const c of [1000, 2500, 5000]) expect(CreateGiftRequest.safeParse({ ...gift, usdCents: c }).success).toBe(true);
    for (const c of [0, 999, 1500, 10000, 10.5, "1000"]) {
      expect(CreateGiftRequest.safeParse({ ...gift, usdCents: c }).success).toBe(false);
    }
  });

  it("create gift validates names, ticker, note and opensAt", () => {
    expect(CreateGiftRequest.safeParse({ ...gift, note: "hi", opensAt: "2026-12-25T08:00:00Z" }).success).toBe(true);
    expect(CreateGiftRequest.safeParse({ ...gift, ticker: "tNVDA" }).success).toBe(false);
    expect(CreateGiftRequest.safeParse({ ...gift, senderName: "   " }).success).toBe(false);
    expect(CreateGiftRequest.safeParse({ ...gift, note: "x".repeat(281) }).success).toBe(false);
    expect(CreateGiftRequest.safeParse({ ...gift, opensAt: "tomorrow" }).success).toBe(false);
    expect(CreateGiftRequest.safeParse({ ...gift, priceCents: 1 }).success).toBe(false);
  });

  it("create response requires a uuid and token", () => {
    expect(
      CreateGiftResponse.safeParse({ id: fixtures.single.wrapped.id, claimToken: "a".repeat(43) }).success,
    ).toBe(true);
    expect(CreateGiftResponse.safeParse({ id: "1", claimToken: "a".repeat(43) }).success).toBe(false);
  });

  it("group goal is at most 10000", () => {
    const g = { organizerName: "Jordan", recipientName: "Grandma", ticker: "COST", goalCents: 10000 };
    expect(CreateGroupRequest.safeParse(g).success).toBe(true);
    expect(CreateGroupRequest.safeParse({ ...g, goalCents: 10001 }).success).toBe(false);
    expect(CreateGroupRequest.safeParse({ ...g, goalCents: 0 }).success).toBe(false);
  });

  it("contribution requires a uuid idempotency key", () => {
    const c = { name: "Sam", usdCents: 2500, idempotencyKey: "5d3c3a0e-6b8e-4c43-9a51-2f7f1c1f7b10" };
    expect(CreateContributionRequest.safeParse(c).success).toBe(true);
    expect(CreateContributionRequest.safeParse({ ...c, idempotencyKey: "retry-1" }).success).toBe(false);
  });

  it("swap and claim", () => {
    expect(SwapGiftRequest.safeParse({ ticker: "AAPL" }).success).toBe(true);
    expect(SwapGiftRequest.safeParse({ ticker: "AAPL", usdCents: 5000 }).success).toBe(false);
    expect(ClaimGiftRequest.safeParse({ wallet: "11111111111111111111111111111111" }).success).toBe(true);
    for (const wallet of ["0x1234", "O".repeat(44), "", "1".repeat(45)]) {
      expect(ClaimGiftRequest.safeParse({ wallet }).success).toBe(false);
    }
  });
});

describe("responses and errors", () => {
  it("claim response is claimed (200) or pending (202)", () => {
    const claimed = fixtures.single.claimed;
    const signature = claimed.status === "claimed" ? claimed.claimSignature : "";
    expect(ClaimGiftResponse.safeParse({ status: "claimed", signature, gift: claimed }).success).toBe(true);
    expect(
      ClaimGiftResponse.safeParse({ status: "pending", signature: null, gift: fixtures.single.claiming }).success,
    ).toBe(true);
  });

  it("contribution response carries the group state", () => {
    const res = {
      contribution: { id: "5d3c3a0e-6b8e-4c43-9a51-2f7f1c1f7b10", name: "Sam", usdCents: 2500, createdAt: "2026-11-28T15:00:00Z" },
      gift: fixtures.group.funding,
    };
    expect(CreateContributionResponse.safeParse(res).success).toBe(true);
    expect(CreateContributionResponse.safeParse({ ...res, gift: fixtures.single.wrapped }).success).toBe(false);
  });

  it("errors have the { error: { code, message } } shape", () => {
    expect(ApiError.safeParse({ error: { code: "too_early", message: "Opens later" } }).success).toBe(true);
    expect(ApiError.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(false);
    expect(ApiError.safeParse({ code: "too_early", message: "x" }).success).toBe(false);
    expect(ERROR_STATUS.too_early).toBe(425);
  });
});
