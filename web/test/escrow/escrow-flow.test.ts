/**
 * End to end with escrow on solana-test-validator (pnpm --filter @stoked/web
 * test:escrow): route handlers → env wiring → service → PGlite (real
 * migrations) → the compiled program.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { deriveMintAddresses, getTokenBalance, setupMints } from "@stoked/chain";
import { ESCROW_PROGRAM_ID, deriveClaimKey, readGift, vaultAddress } from "@stoked/chain/escrow";
import { ApiError, ClaimGiftResponse, CreateGiftResponse, PublicGift } from "@stoked/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as claimPOST } from "../../app/api/gifts/[id]/claim/route";
import { POST as openPOST } from "../../app/api/gifts/[id]/open/route";
import { GET as giftGET } from "../../app/api/gifts/[id]/route";
import { POST as swapPOST } from "../../app/api/gifts/[id]/swap/route";
import { POST as createPOST } from "../../app/api/gifts/route";
import { setServiceForTests } from "../../lib/server/env";
import { localDbClient } from "../../lib/server/local-db";

const url = process.env.SOLANA_RPC_URL;
if (!url || !process.env.ESCROW_PROGRAM_ID) throw new Error("run via `pnpm test:escrow`");
const connection = new Connection(url, "confirmed");
const treasury = Keypair.generate();
const mint = deriveMintAddresses(treasury.publicKey).tNVDA;

beforeAll(async () => {
  const signature = await connection.requestAirdrop(treasury.publicKey, 100 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
  await setupMints({ connection, treasury });
  // The real env wiring, with a throwaway treasury and the local database.
  for (const k of Object.keys(process.env)) if (k.startsWith("MINT_") || k.startsWith("SUPABASE_")) delete process.env[k];
  process.env.TREASURY_SECRET_KEY = JSON.stringify(Array.from(treasury.secretKey));
  process.env.STOKED_LOCAL_DB = "1";
});

/** A fresh service reading the flag, as after a redeploy. The database persists. */
function setFlag(on: boolean) {
  process.env.STOKED_ESCROW = on ? "1" : "";
  setServiceForTests(undefined);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, token?: string) =>
  new Request("http://test.local/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function create() {
  const res = await createPOST(post({ senderName: "Alex", recipientName: "Maya", ticker: "tNVDA", usdCents: 1000 }));
  expect(res.status).toBe(200);
  const { id, claimToken } = CreateGiftResponse.parse(await res.json());
  const { rows } = await localDbClient().query<{ escrow_account: string | null }>(
    "select escrow_account from gifts where id = $1",
    [id],
  );
  const account = rows[0]!.escrow_account;
  return { id, token: claimToken, account: account ? new PublicKey(account) : null };
}

async function open(g: { id: string; token: string }) {
  const res = await openPOST(post(undefined, g.token), params(g.id));
  expect(res.status).toBe(200);
}

async function claim(g: { id: string; token: string }, wallet: PublicKey) {
  const send = () => claimPOST(post({ wallet: wallet.toBase58() }, g.token), params(g.id));
  let res = await send();
  for (let i = 0; i < 20 && res.status === 202; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await send();
  }
  expect(res.status).toBe(200);
  const body = ClaimGiftResponse.parse(await res.json());
  if (body.status !== "claimed") throw new Error("expected claimed");
  return body.signature;
}

const raw = async (owner: PublicKey) => (await getTokenBalance(connection, mint, owner)).raw;
const vault = (account: PublicKey) => connection.getAccountInfo(vaultAddress(ESCROW_PROGRAM_ID, account), "confirmed");

describe("API with STOKED_ESCROW=1 on solana-test-validator", () => {
  it("locks at creation, refuses a swap, and claims from the vault exactly once", async () => {
    setFlag(true);
    const before = await raw(treasury.publicKey);
    const g = await create();
    const account = g.account!;
    const locked = await connection.getTokenAccountBalance(vaultAddress(ESCROW_PROGRAM_ID, account), "confirmed");
    expect(locked.value.amount).toBe("4356918");
    expect(await raw(treasury.publicKey)).toBe(before - 4356918n);
    const { gift } = await readGift(connection, ESCROW_PROGRAM_ID, account);
    expect(gift).toMatchObject({ status: "open", sender: treasury.publicKey, mint, amount: 4356918n, openAt: 0n });
    expect(gift!.claimKey).toEqual(deriveClaimKey(g.token, g.id).publicKey);

    const wrapped = PublicGift.parse(await (await giftGET(new Request("http://test.local"), params(g.id))).json());
    expect(wrapped.status).toBe("wrapped");
    await open(g);
    const swap = await swapPOST(post({ ticker: "tAAPL" }, g.token), params(g.id));
    expect(swap.status).toBe(409);
    expect(ApiError.parse(await swap.json()).error.code).toBe("invalid_state");

    const recipient = Keypair.generate().publicKey;
    const signature = await claim(g, recipient);
    expect(await raw(recipient)).toBe(4356918n);
    expect(await vault(account)).toBeNull();
    expect((await readGift(connection, ESCROW_PROGRAM_ID, account)).gift).toMatchObject({
      status: "claimed",
      recipient,
    });
    // The treasury paid once, at creation.
    expect(await raw(treasury.publicKey)).toBe(before - 4356918n);
    const [status] = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value;
    expect(status?.err).toBeNull();

    expect(await claim(g, recipient)).toBe(signature);
    expect(await raw(recipient)).toBe(4356918n);
  });

  it("keeps each gift's mode when the flag changes", async () => {
    setFlag(true);
    const escrowed = await create();
    setFlag(false);
    const plain = await create();
    expect(plain.account).toBeNull();

    const before = await raw(treasury.publicKey);
    await open(escrowed);
    const first = Keypair.generate().publicKey;
    await claim(escrowed, first);
    expect(await raw(first)).toBe(4356918n);
    expect(await raw(treasury.publicKey)).toBe(before);
    expect(await vault(escrowed.account!)).toBeNull();

    setFlag(true);
    await open(plain);
    const second = Keypair.generate().publicKey;
    await claim(plain, second);
    expect(await raw(second)).toBe(4356918n);
    expect(await raw(treasury.publicKey)).toBe(before - 4356918n);
  });
});
