import { describe, expect, it } from "vitest";
import { allFixtures, fixtures } from "../src/fixtures";
import {
  ApiError,
  ClaimGiftRequest,
  ClaimGiftResponse,
  CreateGiftRequest,
  CreateGiftResponse,
  ERROR_STATUS,
  GIFT_STATUSES,
  PublicGift,
  PublicGiftWrapped,
  SwapGiftRequest,
  TICKERS,
  UNDERLYING,
} from "../src/schemas";

describe("public schema for a wrapped gift", () => {
  const wrapped = fixtures.wrapped;

  it("accepts the wrapped fixture", () => {
    expect(PublicGiftWrapped.safeParse(wrapped).success).toBe(true);
    expect(PublicGift.safeParse(wrapped).success).toBe(true);
  });

  for (const [key, value] of [
    ["ticker", "tNVDA"],
    ["usdCents", 1000],
    ["note", "Happy birthday"],
  ] as const) {
    it(`rejects ${key}`, () => {
      const leaked = { ...wrapped, [key]: value };
      expect(PublicGiftWrapped.safeParse(leaked).success).toBe(false);
      expect(PublicGift.safeParse(leaked).success).toBe(false);
    });

    it(`rejects ${key} even when null`, () => {
      expect(PublicGift.safeParse({ ...wrapped, [key]: null }).success).toBe(false);
    });
  }

  it("rejects the value and raw amount too", () => {
    const opened = fixtures.opened;
    if (opened.status !== "opened") throw new Error("fixture");
    expect(PublicGift.safeParse({ ...wrapped, tokenRaw: opened.tokenRaw }).success).toBe(false);
    expect(PublicGift.safeParse({ ...wrapped, value: opened.value }).success).toBe(false);
  });
});

describe("fixtures", () => {
  it("cover every status", () => {
    expect(new Set(allFixtures.map((g) => g.status))).toEqual(new Set(GIFT_STATUSES));
  });

  it.each(allFixtures.map((g) => [`${g.status} ${g.id}`, g] as const))("%s parses", (_name, gift) => {
    expect(PublicGift.safeParse(gift).error?.issues ?? []).toEqual([]);
  });

  it("show the reference share count", () => {
    expect(fixtures.opened.status === "opened" && fixtures.opened.value.shares).toBe("0.0436");
  });

  it("an opened gift requires its contents", () => {
    const { note: _note, ...withoutNote } = fixtures.opened as Record<string, unknown>;
    expect(PublicGift.safeParse(withoutNote).success).toBe(false);
  });

  it("a claimed gift requires its signature", () => {
    expect(PublicGift.safeParse({ ...fixtures.claimed, claimSignature: null }).success).toBe(false);
  });

  it("there is no funding status or group kind", () => {
    expect(PublicGift.safeParse({ ...fixtures.wrapped, status: "funding" }).success).toBe(false);
    expect(PublicGift.safeParse({ ...fixtures.wrapped, kind: "single" }).success).toBe(false);
  });
});

describe("tickers", () => {
  it("are the tokenized names, each mapped to its underlying stock", () => {
    expect(TICKERS).toEqual(["tNVDA", "tAAPL", "tSPY", "tTSLA", "tCOST"]);
    expect(UNDERLYING.tNVDA).toEqual({ symbol: "NVDA", name: "Nvidia" });
  });
});

describe("requests", () => {
  const gift = { senderName: "Alex", recipientName: "Maya", ticker: "tNVDA", usdCents: 1000 };

  it("create gift accepts only 1000, 2500 or 5000 cents", () => {
    for (const c of [1000, 2500, 5000]) expect(CreateGiftRequest.safeParse({ ...gift, usdCents: c }).success).toBe(true);
    for (const c of [0, 999, 1500, 10000, 10.5, "1000"]) {
      expect(CreateGiftRequest.safeParse({ ...gift, usdCents: c }).success).toBe(false);
    }
  });

  it("create gift validates names, ticker, note and opensAt", () => {
    expect(CreateGiftRequest.safeParse({ ...gift, note: "hi", opensAt: "2026-12-25T08:00:00Z" }).success).toBe(true);
    expect(CreateGiftRequest.safeParse({ ...gift, ticker: "NVDA" }).success).toBe(false);
    expect(CreateGiftRequest.safeParse({ ...gift, senderName: "   " }).success).toBe(false);
    expect(CreateGiftRequest.safeParse({ ...gift, note: "x".repeat(281) }).success).toBe(false);
    expect(CreateGiftRequest.safeParse({ ...gift, opensAt: "tomorrow" }).success).toBe(false);
    expect(CreateGiftRequest.safeParse({ ...gift, priceCents: 1 }).success).toBe(false);
  });

  it("create response requires a uuid and token", () => {
    expect(CreateGiftResponse.safeParse({ id: fixtures.wrapped.id, claimToken: "a".repeat(43) }).success).toBe(true);
    expect(CreateGiftResponse.safeParse({ id: "1", claimToken: "a".repeat(43) }).success).toBe(false);
  });

  it("swap and claim", () => {
    expect(SwapGiftRequest.safeParse({ ticker: "tAAPL" }).success).toBe(true);
    expect(SwapGiftRequest.safeParse({ ticker: "tAAPL", usdCents: 5000 }).success).toBe(false);
    expect(ClaimGiftRequest.safeParse({ wallet: "11111111111111111111111111111111" }).success).toBe(true);
    for (const wallet of ["0x1234", "O".repeat(44), "", "1".repeat(45)]) {
      expect(ClaimGiftRequest.safeParse({ wallet }).success).toBe(false);
    }
  });
});

describe("responses and errors", () => {
  it("claim response is claimed (200) or pending (202)", () => {
    const claimed = fixtures.claimed;
    const signature = claimed.status === "claimed" ? claimed.claimSignature : "";
    expect(ClaimGiftResponse.safeParse({ status: "claimed", signature, gift: claimed }).success).toBe(true);
    expect(ClaimGiftResponse.safeParse({ status: "pending", signature: null, gift: fixtures.claiming }).success).toBe(true);
  });

  it("errors have the { error: { code, message } } shape", () => {
    expect(ApiError.safeParse({ error: { code: "too_early", message: "Opens later" } }).success).toBe(true);
    expect(ApiError.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(false);
    expect(ApiError.safeParse({ code: "too_early", message: "x" }).success).toBe(false);
    expect(ERROR_STATUS.too_early).toBe(425);
  });
});
