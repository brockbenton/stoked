import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
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
  const conn = (status: Status, finalizedHeight: number, landed: unknown = null) =>
    ({
      getSignatureStatuses: async () => ({ value: [status] }),
      getBlockHeight: async () => finalizedHeight,
      getTransaction: async () => landed,
    }) as unknown as Parameters<typeof getClaimStatus>[0];

  it("confirmed when the signature is confirmed or finalized", async () => {
    expect(await getClaimStatus(conn({ err: null, confirmationStatus: "confirmed" }, 0), sig, 100n)).toEqual({
      state: "confirmed",
    });
    expect(await getClaimStatus(conn({ err: null, confirmationStatus: "finalized" }, 0), sig, 100n)).toEqual({
      state: "confirmed",
    });
  });
  it("failed when the transaction errored", async () => {
    const s = await getClaimStatus(conn({ err: { InstructionError: [1, "Custom"] } }, 0), sig, 100n);
    expect(s.state).toBe("failed");
  });
  it("pending when unknown and the blockhash may still land", async () => {
    expect(await getClaimStatus(conn(null, 100), sig, 100n)).toEqual({ state: "pending" });
  });
  it("expired only past the height with no finalized landing", async () => {
    expect(await getClaimStatus(conn(null, 101), sig, 100n)).toEqual({ state: "expired" });
    expect(await getClaimStatus(conn(null, 101, { meta: { err: null } }), sig, 100n)).toEqual({
      state: "confirmed",
    });
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
