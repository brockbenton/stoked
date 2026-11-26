import type { Ticker } from "@stoked/shared";
import { describe, expect, it, vi } from "vitest";
import { localDbAllowed } from "../../lib/server/env";
import { createRateLimiter } from "../../lib/server/rate-limit";
import { createWalletService, type WalletDeps } from "../../lib/server/wallet";
import { NOW, VALID_WALLET } from "./harness";

const service = (over: Partial<WalletDeps> = {}) =>
  createWalletService({
    rawHoldings: async () => ({ tAAPL: 4356918n, tNVDA: 100_000_000n }),
    multiplierSchedule: async (t: Ticker) => ({ multiplier: t === "tAAPL" ? 1.002 : 1 }),
    rateLimiter: createRateLimiter({ perKey: 100, global: 100, windowMs: 60_000 }),
    now: () => NOW,
    ...over,
  });

describe("wallet balances", () => {
  it("lists held tokens in ticker order with each mint's multiplier applied", async () => {
    await expect(service().holdings(VALID_WALLET, "ip")).resolves.toEqual({
      wallet: VALID_WALLET,
      holdings: [
        { ticker: "tNVDA", tokenRaw: "100000000", multiplier: "1", shares: "1.0000", sharesExact: "1.00000000" },
        { ticker: "tAAPL", tokenRaw: "4356918", multiplier: "1.002", shares: "0.0437", sharesExact: "0.04365631" },
      ],
    });
  });

  it("reads no multiplier for an empty wallet", async () => {
    const multiplierSchedule = vi.fn();
    const res = await service({ rawHoldings: async () => ({}), multiplierSchedule }).holdings(VALID_WALLET, "ip");
    expect(res.holdings).toEqual([]);
    expect(multiplierSchedule).not.toHaveBeenCalled();
  });

  it("refuses a bad address before touching the chain", async () => {
    const rawHoldings = vi.fn();
    await expect(service({ rawHoldings }).holdings("nope", "ip")).rejects.toMatchObject({ code: "invalid_wallet" });
    expect(rawHoldings).not.toHaveBeenCalled();
  });

  it("is rate limited per client", async () => {
    const s = service({ rateLimiter: createRateLimiter({ perKey: 1, global: 10, windowMs: 60_000 }) });
    await s.holdings(VALID_WALLET, "a");
    await expect(s.holdings(VALID_WALLET, "a")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(s.holdings(VALID_WALLET, "b")).resolves.toBeTruthy();
  });

  it("reports RPC failure without leaking its text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = service({
      rawHoldings: async () => {
        throw new Error("https://rpc.example/?api-key=secret");
      },
    });
    const err = await s.holdings(VALID_WALLET, "ip").catch((e: unknown) => e as Error & { code: string });
    expect(err).toMatchObject({ code: "chain_unavailable" });
    expect((err as Error).message).not.toContain("secret");
    log.mockRestore();
  });
});

describe("local database guard", () => {
  it("allows only a local validator, never a deployment", () => {
    expect(localDbAllowed({ SOLANA_RPC_URL: "http://127.0.0.1:8899" })).toBe(true);
    expect(localDbAllowed({ SOLANA_RPC_URL: "http://localhost:8899" })).toBe(true);
    expect(localDbAllowed({ SOLANA_RPC_URL: "https://api.devnet.solana.com" })).toBe(false);
    expect(localDbAllowed({ SOLANA_RPC_URL: "http://127.0.0.1:8899", VERCEL: "1" })).toBe(false);
    expect(localDbAllowed({})).toBe(false);
  });
});
