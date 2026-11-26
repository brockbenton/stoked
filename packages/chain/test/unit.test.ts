import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  EXPIRY_MARGIN_BLOCKS,
  GENESIS_HASHES,
  UnsafeClusterError,
  assertSafeCluster,
  chainConfigFromEnv,
  createStubChain,
  deriveMintAddress,
  deriveMintAddresses,
  getClaimStatus,
  NotImplementedError,
  parseSecretKey,
} from "../src/index";

const fakeConn = (hash: string, rpcEndpoint = "https://rpc.example.com") => ({
  getGenesisHash: async () => hash,
  rpcEndpoint,
});

describe("cluster guard", () => {
  it("refuses mainnet by genesis hash, even on a local-looking URL", async () => {
    await expect(assertSafeCluster(fakeConn(GENESIS_HASHES.mainnet))).rejects.toBeInstanceOf(UnsafeClusterError);
    await expect(assertSafeCluster(fakeConn(GENESIS_HASHES.mainnet, "http://127.0.0.1:8899"))).rejects.toThrow(
      /mainnet/,
    );
  });
  it("refuses testnet", async () => {
    await expect(assertSafeCluster(fakeConn(GENESIS_HASHES.testnet))).rejects.toBeInstanceOf(UnsafeClusterError);
  });
  it("allows devnet anywhere", async () => {
    await expect(assertSafeCluster(fakeConn(GENESIS_HASHES.devnet))).resolves.toBe("devnet");
  });
  it("allows an unknown genesis only on loopback", async () => {
    const local = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
    await expect(assertSafeCluster(fakeConn(local, "http://127.0.0.1:8899"))).resolves.toBe("local");
    await expect(assertSafeCluster(fakeConn(local, "http://localhost:8899"))).resolves.toBe("local");
    await expect(assertSafeCluster(fakeConn(local))).rejects.toBeInstanceOf(UnsafeClusterError);
  });
});

describe("mint addresses", () => {
  it("match PublicKey.createWithSeed", async () => {
    const t = Keypair.generate().publicKey;
    const { TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
    const expected = await PublicKey.createWithSeed(t, "stoked:v1:tNVDA", TOKEN_2022_PROGRAM_ID);
    expect(deriveMintAddress(t, "tNVDA").equals(expected)).toBe(true);
  });
  it("are deterministic per treasury and distinct per ticker", () => {
    const t = Keypair.generate().publicKey;
    const a = deriveMintAddresses(t);
    expect(deriveMintAddress(t, "tNVDA").equals(a.tNVDA)).toBe(true);
    expect(new Set(Object.values(a).map((k) => k.toBase58())).size).toBe(5);
    const other = deriveMintAddresses(Keypair.generate().publicKey);
    expect(other.tNVDA.equals(a.tNVDA)).toBe(false);
  });
});

describe("env config", () => {
  it("parses a 64-byte secret and errors without echoing bad input", () => {
    const kp = Keypair.generate();
    expect(parseSecretKey(JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey)).toBe(true);
    const secretish = "[1,2,3,zq9marker]";
    try {
      parseSecretKey(secretish);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain("zq9marker");
    }
    expect(() => parseSecretKey("[1,2,3]")).toThrow(/64 bytes/);
  });
  it("prefers MINT_* env values and falls back to derived addresses", () => {
    const kp = Keypair.generate();
    const override = Keypair.generate().publicKey;
    const cfg = chainConfigFromEnv({
      SOLANA_RPC_URL: "http://127.0.0.1:8899",
      TREASURY_SECRET_KEY: JSON.stringify(Array.from(kp.secretKey)),
      MINT_TNVDA: override.toBase58(),
    });
    expect(cfg.mints!.tNVDA.equals(override)).toBe(true);
    expect(cfg.mints!.tAAPL.equals(deriveMintAddress(kp.publicKey, "tAAPL"))).toBe(true);
  });
});

describe("claim status", () => {
  const sig = "5".repeat(87);
  type Status = { err: unknown; confirmationStatus?: string } | null;
  const conn = (statuses: Status | Status[], finalizedHeight: number, landed: unknown = null) => {
    const queue = Array.isArray(statuses) ? [...statuses] : [statuses];
    return {
      getSignatureStatuses: async (_s: string[], opts: { searchTransactionHistory?: boolean }) => {
        expect(opts.searchTransactionHistory).toBe(true);
        return { value: [queue.length > 1 ? queue.shift() : queue[0]] };
      },
      getBlockHeight: async (commitment: string) => {
        expect(commitment).toBe("finalized");
        return finalizedHeight;
      },
      getTransaction: async (_s: string, opts: { commitment?: string }) => {
        expect(opts.commitment).toBe("finalized");
        return landed;
      },
    } as unknown as Parameters<typeof getClaimStatus>[0];
  };
  const last = 100n;
  const pastMargin = Number(last + EXPIRY_MARGIN_BLOCKS) + 1;

  it("confirmed when the signature is confirmed or finalized", async () => {
    expect(await getClaimStatus(conn({ err: null, confirmationStatus: "confirmed" }, 0), sig, last)).toEqual({
      state: "confirmed",
    });
    expect(await getClaimStatus(conn({ err: null, confirmationStatus: "finalized" }, 0), sig, last)).toEqual({
      state: "confirmed",
    });
  });
  it("failed only when the error is confirmed", async () => {
    const err = { InstructionError: [1, "Custom"] };
    expect((await getClaimStatus(conn({ err, confirmationStatus: "confirmed" }, 0), sig, last)).state).toBe("failed");
  });
  it("pending, not failed, for an error seen only at processed (fork may be dropped)", async () => {
    const err = { InstructionError: [1, "Custom"] };
    expect(await getClaimStatus(conn({ err, confirmationStatus: "processed" }, 0), sig, last)).toEqual({
      state: "pending",
    });
  });
  it("pending when unknown and within the expiry margin (it can land at last valid height + 1)", async () => {
    expect(await getClaimStatus(conn(null, 100), sig, last)).toEqual({ state: "pending" });
    expect(await getClaimStatus(conn(null, 101), sig, last)).toEqual({ state: "pending" });
    expect(await getClaimStatus(conn(null, pastMargin - 1), sig, last)).toEqual({ state: "pending" });
  });
  it("expired only past the margin with no finalized landing", async () => {
    expect(await getClaimStatus(conn(null, pastMargin), sig, last)).toEqual({ state: "expired" });
    expect(await getClaimStatus(conn(null, pastMargin, { meta: { err: null } }), sig, last)).toEqual({
      state: "confirmed",
    });
  });
  it("re-checks statuses before declaring expiry", async () => {
    const statuses: Status[] = [null, { err: null, confirmationStatus: "finalized" }];
    expect(await getClaimStatus(conn(statuses, pastMargin), sig, last)).toEqual({ state: "confirmed" });
  });
});

describe("stub adapter", () => {
  it("refuses every call without touching a cluster", async () => {
    const chain = createStubChain();
    await expect(chain.multiplierSchedule("tNVDA")).rejects.toBeInstanceOf(NotImplementedError);
    await expect(chain.claimStatus("sig", 1n)).rejects.toBeInstanceOf(NotImplementedError);
    expect(PublicKey.default).toBeDefined();
  });
});
