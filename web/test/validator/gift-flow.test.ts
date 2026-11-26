/**
 * End to end on a real solana-test-validator (pnpm --filter web test:validator):
 * route handlers → service → PGlite (real migration) → createSolanaChain →
 * Token-2022 mints set up by @stoked/chain.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createSolanaChain, deriveMintAddresses, getTokenBalance, setupMints } from "@stoked/chain";
import { ClaimGiftResponse, CreateGiftResponse, PublicGift } from "@stoked/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as claimPOST } from "../../app/api/gifts/[id]/claim/route";
import { POST as openPOST } from "../../app/api/gifts/[id]/open/route";
import { GET as giftGET } from "../../app/api/gifts/[id]/route";
import { POST as createPOST } from "../../app/api/gifts/route";
import { setServiceForTests } from "../../lib/server/env";
import { createRateLimiter } from "../../lib/server/rate-limit";
import { createGiftService } from "../../lib/server/service";
import { createSqlGiftStore } from "../../lib/server/store-sql";
import { freshDb } from "../server/harness";

const url = process.env.SOLANA_RPC_URL;
if (!url) throw new Error("SOLANA_RPC_URL not set: run via `pnpm test:validator`");
const connection = new Connection(url, "confirmed");
const treasury = Keypair.generate();
let db: Awaited<ReturnType<typeof freshDb>>;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, token?: string) =>
  new Request("http://test.local/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  const sig = await connection.requestAirdrop(treasury.publicKey, 100 * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  await setupMints({ connection, treasury });
  db = await freshDb();
  setServiceForTests(
    createGiftService({
      store: createSqlGiftStore(db),
      chain: createSolanaChain({ connection, treasury }),
      rateLimiter: createRateLimiter({ perKey: 10, global: 10, windowMs: 60_000 }),
      confirmPolls: 60,
      confirmIntervalMs: 500,
    }),
  );
});

afterAll(async () => {
  setServiceForTests(undefined);
  await db?.close();
});

describe("gift flow on solana-test-validator", () => {
  it("creates, opens and claims a gift; the recipient holds exactly the gift's raw units", async () => {
    const created = await createPOST(post({ senderName: "Alex", recipientName: "Maya", ticker: "tNVDA", usdCents: 1000 }));
    expect(created.status).toBe(200);
    const { id, claimToken } = CreateGiftResponse.parse(await created.json());

    const wrapped = PublicGift.parse(await (await giftGET(new Request("http://test.local"), params(id))).json());
    expect(wrapped.status).toBe("wrapped");

    const opened = await openPOST(post(undefined, claimToken), params(id));
    expect(opened.status).toBe(200);
    const og = PublicGift.parse(await opened.json());
    if (og.status !== "opened") throw new Error("expected opened");
    expect(og.tokenRaw).toBe("4356918");

    const recipient = Keypair.generate().publicKey; // brand-new wallet: no token account yet
    let res = await claimPOST(post({ wallet: recipient.toBase58() }, claimToken), params(id));
    for (let i = 0; i < 20 && res.status === 202; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      res = await claimPOST(post({ wallet: recipient.toBase58() }, claimToken), params(id));
    }
    expect(res.status).toBe(200);
    const body = ClaimGiftResponse.parse(await res.json());
    if (body.status !== "claimed") throw new Error("expected claimed");

    const mint = deriveMintAddresses(treasury.publicKey).tNVDA;
    const bal = await getTokenBalance(connection, mint, recipient);
    expect(bal.raw).toBe(4356918n);

    const [status] = (await connection.getSignatureStatuses([body.signature], { searchTransactionHistory: true })).value;
    expect(status?.err).toBeNull();
    expect(["confirmed", "finalized"]).toContain(status?.confirmationStatus);

    // Retrying a claimed gift pays nothing more.
    const again = await claimPOST(post({ wallet: recipient.toBase58() }, claimToken), params(id));
    expect(again.status).toBe(200);
    expect((await getTokenBalance(connection, mint, new PublicKey(recipient))).raw).toBe(4356918n);
  });
});
