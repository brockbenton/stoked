/**
 * Runs against a real solana-test-validator (pnpm --filter @stoked/chain test:validator).
 */
import { LAMPORTS_PER_SOL, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TICKERS } from "@stoked/shared";
import { beforeAll, describe, expect, it } from "vitest";
import {
  GENESIS_HASHES,
  UnsafeClusterError,
  assertSafeCluster,
  buildClaimTransaction,
  createSolanaChain,
  deriveMintAddresses,
  getClaimStatus,
  getMultiplierSchedule,
  getTokenBalance,
  hasScaledUiAmount,
  sendClaimTransaction,
  setupMints,
  updateMultiplier,
  waitForClaim,
  type MintAddresses,
} from "../../src/index";
import { getTokenMetadata } from "@solana/spl-token";

const url = process.env.SOLANA_RPC_URL;
if (!url) throw new Error("SOLANA_RPC_URL not set: run via `pnpm test:validator`");
const connection = new Connection(url, "confirmed");
const treasury = Keypair.generate();
let mints: MintAddresses;

beforeAll(async () => {
  const sig = await connection.requestAirdrop(treasury.publicKey, 100 * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  mints = deriveMintAddresses(treasury.publicKey);
});

describe("cluster guard (genesis hash)", () => {
  it("identifies the local validator as safe", async () => {
    expect(await assertSafeCluster(connection)).toBe("local");
  });
  it("refuses a connection whose genesis hash is mainnet", async () => {
    const mainnetLike = new Connection(url, "confirmed");
    mainnetLike.getGenesisHash = async () => GENESIS_HASHES.mainnet;
    await expect(assertSafeCluster(mainnetLike)).rejects.toBeInstanceOf(UnsafeClusterError);
    await expect(setupMints({ connection: mainnetLike, treasury })).rejects.toThrow(/mainnet/);
    await expect(
      updateMultiplier({ connection: mainnetLike, treasury, mint: PublicKey.unique(), multiplier: 2 }),
    ).rejects.toThrow(/mainnet/);
    await expect(
      buildClaimTransaction({
        connection: mainnetLike,
        treasury,
        mint: PublicKey.unique(),
        recipient: Keypair.generate().publicKey,
        raw: 1n,
      }),
    ).rejects.toThrow(/mainnet/);
    const chain = createSolanaChain({ connection: mainnetLike, treasury });
    await expect(
      chain.buildClaim({ ticker: "tNVDA", recipientWallet: Keypair.generate().publicKey.toBase58(), raw: 1n }),
    ).rejects.toThrow(/mainnet/);
  });
});

describe("mint setup", () => {
  it("creates five Token-2022 mints with Scaled UI Amount, metadata and treasury supply", async () => {
    const first = await setupMints({ connection, treasury });
    expect(first.map((r) => r.ticker)).toEqual([...TICKERS]);
    for (const r of first) {
      expect(r.actions).toContain("created-mint");
      expect(r.actions).toContain("minted-supply");
      expect(r.mint.equals(mints[r.ticker])).toBe(true);
      const info = await connection.getAccountInfo(r.mint);
      expect(info?.owner.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
      expect(await hasScaledUiAmount(connection, r.mint)).toBe(true);
      const schedule = await getMultiplierSchedule(connection, r.mint);
      expect(schedule.multiplier).toBe(1);
      const meta = await getTokenMetadata(connection, r.mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      expect(meta?.symbol).toBe(r.ticker);
      expect(meta?.name).toMatch(/devnet test token/);
      const supply = await connection.getTokenSupply(r.mint);
      expect(supply.value.decimals).toBe(8);
      expect(BigInt(supply.value.amount)).toBeGreaterThan(0n);
    }
    console.log("mints:", first.map((r) => `${r.ticker}=${r.mint.toBase58()}`).join(" "));
  });

  it("rerunning setup creates nothing", async () => {
    const before = await Promise.all(TICKERS.map((t) => connection.getTokenSupply(mints[t])));
    const again = await setupMints({ connection, treasury });
    for (const r of again) expect(r.actions).toEqual([]);
    const after = await Promise.all(TICKERS.map((t) => connection.getTokenSupply(mints[t])));
    expect(after.map((s) => s.value.amount)).toEqual(before.map((s) => s.value.amount));
  });
});

describe("claim transfer", () => {
  it("works for a wallet with no token account, with the signature known before sending", async () => {
    const recipient = Keypair.generate().publicKey;
    const mint = mints.tNVDA;
    const ata = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);
    expect(await connection.getAccountInfo(ata)).toBeNull();

    const claim = await buildClaimTransaction({ connection, treasury, mint, recipient, raw: 4_356_918n });
    // Nothing broadcast yet: the signature is unknown to the cluster.
    expect(await getClaimStatus(connection, claim.signature, claim.lastValidBlockHeight)).toEqual({ state: "pending" });

    expect(await sendClaimTransaction(connection, claim)).toBe(claim.signature);
    expect(await waitForClaim(connection, claim)).toEqual({ state: "confirmed" });
    const bal = await getTokenBalance(connection, mint, recipient);
    expect(bal.raw).toBe(4_356_918n);
    expect(bal.shown).toBe("0.0436");
  });

  it("sending the same signed transaction twice transfers once", async () => {
    const recipient = Keypair.generate().publicKey;
    const mint = mints.tAAPL;
    const treasuryBefore = (await getTokenBalance(connection, mint, treasury.publicKey)).raw;
    const claim = await buildClaimTransaction({ connection, treasury, mint, recipient, raw: 1_000_000n });

    await sendClaimTransaction(connection, claim);
    await sendClaimTransaction(connection, claim); // immediate duplicate
    expect(await waitForClaim(connection, claim)).toEqual({ state: "confirmed" });
    await sendClaimTransaction(connection, claim); // duplicate after confirmation
    await new Promise((r) => setTimeout(r, 1500));

    expect((await getTokenBalance(connection, mint, recipient)).raw).toBe(1_000_000n);
    expect((await getTokenBalance(connection, mint, treasury.publicKey)).raw).toBe(treasuryBefore - 1_000_000n);
  });

  it("the adapter builds, sends and reports status by ticker", async () => {
    const chain = createSolanaChain({ connection, treasury });
    const recipient = Keypair.generate().publicKey;
    const claim = await chain.buildClaim({ ticker: "tCOST", recipientWallet: recipient.toBase58(), raw: 123n });
    await chain.sendClaim(claim);
    expect(await waitForClaim(connection, claim)).toEqual({ state: "confirmed" });
    expect(await chain.claimStatus(claim.signature, claim.lastValidBlockHeight)).toEqual({ state: "confirmed" });
    expect((await getTokenBalance(connection, mints.tCOST, recipient)).raw).toBe(123n);
  });
});

describe("multiplier", () => {
  it("after a change the raw balance is identical and the shown balance changes", async () => {
    const recipient = Keypair.generate().publicKey;
    const mint = mints.tSPY;
    const ata = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);
    const claim = await buildClaimTransaction({ connection, treasury, mint, recipient, raw: 4_356_918n });
    await sendClaimTransaction(connection, claim);
    expect(await waitForClaim(connection, claim)).toEqual({ state: "confirmed" });

    const before = await getTokenBalance(connection, mint, recipient);
    const rpcBefore = await connection.getTokenAccountBalance(ata);
    expect(before.shown).toBe("0.0436");

    await updateMultiplier({ connection, treasury, mint, multiplier: 1.002 });

    const schedule = await getMultiplierSchedule(connection, mint);
    expect(schedule.multiplier).toBe(1.002);
    const after = await getTokenBalance(connection, mint, recipient);
    const rpcAfter = await connection.getTokenAccountBalance(ata);

    expect(after.raw).toBe(before.raw);
    expect(rpcAfter.value.amount).toBe(rpcBefore.value.amount);
    expect(after.shown).toBe("0.0437");
    expect(after.shownExact).toBe("0.04365631");
    expect(rpcAfter.value.uiAmountString).not.toBe(rpcBefore.value.uiAmountString);
    console.log(
      `raw ${before.raw} → ${after.raw}; shown ${before.shownExact} → ${after.shownExact}; ` +
        `RPC uiAmount ${rpcBefore.value.uiAmountString} → ${rpcAfter.value.uiAmountString}`,
    );
  });

  it("a scheduled multiplier applies only from its timestamp", async () => {
    const mint = mints.tTSLA;
    const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await updateMultiplier({ connection, treasury, mint, multiplier: 2, effectiveTimestamp: future });
    const schedule = await getMultiplierSchedule(connection, mint);
    expect(schedule.multiplier).toBe(1);
    expect(schedule.newMultiplier).toBe(2);
    const holder = treasury.publicKey;
    const now = await getTokenBalance(connection, mint, holder);
    const later = await getTokenBalance(connection, mint, holder, Number(future));
    expect(later.raw).toBe(now.raw);
    expect(later.shownUnits).toBe(now.shownUnits * 2n);
  });
});
