import { fixtures } from "@stoked/shared";
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../lib/client/http";
import { isNotOlder } from "../lib/client/use-gift-poll";

const TOKEN = "token-token-token-token-token-token";
type Call = { url: string; init: RequestInit };

function client(status: number, body: unknown, opts: { offline?: boolean; fail?: boolean } = {}) {
  const calls: Call[] = [];
  const c = createHttpClient({
    isOffline: () => opts.offline ?? false,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      if (opts.fail) throw new TypeError("fetch failed");
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
  });
  return { c, calls };
}

describe("http client", () => {
  it("sends the claim token only in the Authorization header", async () => {
    const { c, calls } = client(200, fixtures.opened);
    await c.openGift(fixtures.opened.id, TOKEN);
    await c.swapGift(fixtures.opened.id, TOKEN, "tAAPL");
    for (const { url, init } of calls) {
      expect(url).not.toContain(TOKEN);
      expect(String(init.body ?? "")).not.toContain(TOKEN);
      expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
      expect(init.method).toBe("POST");
    }
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[1]!.init.body).toBe('{"ticker":"tAAPL"}');
  });

  it("reads gifts without a token", async () => {
    const { c, calls } = client(200, fixtures.wrapped);
    await expect(c.getGift(fixtures.wrapped.id)).resolves.toEqual(fixtures.wrapped);
    expect(calls[0]!.init.headers).toEqual({});
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("treats a 202 claim as a pending answer, not an error", async () => {
    const { c } = client(202, { status: "pending", signature: null, gift: fixtures.claiming });
    await expect(c.claimGift(fixtures.claiming.id, TOKEN, "w")).resolves.toMatchObject({ status: "pending" });
  });

  it("passes API error codes through", async () => {
    const { c } = client(425, { error: { code: "too_early", message: "This gift opens later" } });
    await expect(c.openGift("x", TOKEN)).rejects.toMatchObject({ code: "too_early", message: "This gift opens later" });
  });

  it("says offline only when the browser is offline", async () => {
    await expect(client(200, {}, { fail: true, offline: true }).c.getGift("x")).rejects.toMatchObject({ code: "offline" });
    await expect(client(200, {}, { fail: true }).c.getGift("x")).rejects.toMatchObject({ code: "internal" });
  });

  it("rejects non-JSON and off-contract responses as internal errors", async () => {
    await expect(client(502, "<html>bad gateway</html>").c.getGift("x")).rejects.toMatchObject({ code: "internal" });
    await expect(client(500, { oops: true }).c.getGift("x")).rejects.toMatchObject({ code: "internal" });
    // A wrapped gift carrying its contents breaks the contract.
    await expect(client(200, { ...fixtures.wrapped, ticker: "tNVDA" }).c.getGift("x")).rejects.toMatchObject({
      code: "internal",
    });
  });
});

describe("background poll", () => {
  it("never moves a gift back to an earlier state", () => {
    expect(isNotOlder(fixtures.wrapped, fixtures.opened)).toBe(false);
    expect(isNotOlder(fixtures.claiming, fixtures.claimed)).toBe(false);
    expect(isNotOlder(fixtures.claimed, fixtures.claiming)).toBe(true);
    expect(isNotOlder(fixtures.opened, fixtures.opened)).toBe(true);
  });
});
