/**
 * A wallet-paid gift on a deployment: pay from a devnet wallet, claim to
 * another, then check both transactions on devnet by RPC. The browser's Phantom
 * is simulated by signing with SMOKE_SENDER_SECRET. See docs/devnet.md.
 */
import { expect, test, type Browser } from "@playwright/test";
import { Connection, Keypair, PublicKey, Transaction, type TokenBalance } from "@solana/web3.js";
import { assertSafeCluster, deriveMintAddresses, parseSecretKey } from "@stoked/chain";
import { AppConfig, PublicGift } from "@stoked/shared";

const secret = process.env.SMOKE_SENDER_SECRET;
test.skip(!secret, "Set SMOKE_SENDER_SECRET to test a deployment with wallet payments");

const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const treasury = new PublicKey(process.env.SMOKE_TREASURY_ADDRESS!);
const mint = deriveMintAddresses(treasury).tNVDA.toBase58();

/** Gets past Vercel's login on preview deployments. Empty for a public URL. */
const access: Record<string, string> = process.env.VERCEL_OIDC_TOKEN
  ? { "x-vercel-trusted-oidc-idp-token": process.env.VERCEL_OIDC_TOKEN }
  : {};

/** A browser whose Phantom extension holds `key`. */
async function device(browser: Browser, baseURL: string, key: Keypair) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const { origin } = new URL(baseURL);
  // Only the deployment under test is sent the access token.
  await context.route(
    (url) => url.origin === origin,
    (route) => route.continue({ headers: { ...route.request().headers(), ...access } }),
  );
  await context.exposeFunction("__walletSign", (bytes: number[]) => {
    const tx = Transaction.from(Uint8Array.from(bytes));
    tx.partialSign(key);
    return Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  });
  await context.addInitScript((address) => {
    const w = window as unknown as Record<string, unknown> & { __walletSign(b: number[]): Promise<number[]> };
    w.phantom = {
      solana: {
        isPhantom: true,
        connect: async () => ({ publicKey: { toString: () => address } }),
        signTransaction: async (tx: { serialize(o: object): Uint8Array }) => {
          const signed = await w.__walletSign(Array.from(tx.serialize({ requireAllSignatures: false })));
          return { serialize: () => Uint8Array.from(signed) };
        },
      },
    };
  }, key.publicKey.toBase58());
  return { context, page: await context.newPage() };
}

const change = (
  meta: { preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null },
  owner: string,
  token: string,
) => {
  const of = (list: TokenBalance[] | null | undefined) =>
    BigInt(list?.find((b) => b.owner === owner && b.mint === token)?.uiTokenAmount.amount ?? "0");
  return of(meta.postTokenBalances) - of(meta.preTokenBalances);
};

async function onChain(signature: string) {
  const lookup = () =>
    connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  await expect.poll(async () => (await lookup()) !== null).toBe(true);
  const meta = (await lookup())!.meta!;
  expect(meta.err).toBeNull();
  return meta;
}

test("pay for a gift from a wallet and claim it to another, on devnet", async ({ browser, baseURL }) => {
  expect(await assertSafeCluster(connection)).toBe("devnet");
  const sender = parseSecretKey(secret!);
  const recipient = Keypair.generate();

  const from = await device(browser, baseURL!, sender);
  const config = AppConfig.parse(await (await from.context.request.get("/api/config", { headers: access })).json());
  expect(config.payment).not.toBeNull();
  const { symbol, mint: paymentMint } = config.payment!;

  await from.page.goto("/");
  await from.page.getByLabel("To", { exact: true }).fill("Maya");
  await from.page.getByLabel("From", { exact: true }).fill("Sam");
  await from.page.getByLabel("Add a note").fill("Devnet wallet smoke test");
  await from.page.getByRole("button", { name: "Connect Phantom" }).click();
  await from.page.getByRole("button", { name: `Pay 10 ${symbol} and wrap Nvidia` }).click();
  await expect(from.page.getByRole("heading", { name: "Wrapped for Maya" })).toBeVisible({ timeout: 180_000 });
  const link = await from.page.getByLabel("Private gift link").inputValue();
  const explorer = await from.page.getByRole("link", { name: "View the payment on explorer" }).getAttribute("href");
  const payment = new URL(explorer!).pathname.split("/").pop()!;
  const id = new URL(link).pathname.split("/").pop()!;

  const to = await device(browser, baseURL!, recipient);
  await to.page.goto(link);
  await to.page.getByRole("button", { name: /Sam sent you a gift/ }).click();
  await to.page.getByRole("button", { name: "Unwrap the gift" }).click();
  await to.page.getByRole("button", { name: "Connect Phantom" }).click();
  await to.page.getByRole("button", { name: "Claim to my Phantom wallet" }).click();
  await expect(to.page.locator("#gift-notice")).toContainText("Claimed.", { timeout: 180_000 });
  await expect(from.page.getByText("Maya claimed it.")).toBeVisible();

  const res = await from.context.request.get(`/api/gifts/${id}`, { headers: access });
  const gift = PublicGift.parse(await res.json());
  if (gift.status !== "claimed") throw new Error(`expected claimed, got ${gift.status}`);
  expect(gift.recipientWallet).toBe(recipient.publicKey.toBase58());
  const raw = BigInt(gift.tokenRaw);

  const paid = await onChain(payment);
  const price = -change(paid, sender.publicKey.toBase58(), paymentMint);
  expect(price > 0n).toBe(true);
  expect(change(paid, treasury.toBase58(), paymentMint)).toBe(price);
  expect(change(paid, treasury.toBase58(), mint)).toBe(-raw);

  const claimed = await onChain(gift.claimSignature);
  expect(change(claimed, recipient.publicKey.toBase58(), mint)).toBe(raw);

  console.log(
    [
      `payment: https://explorer.solana.com/tx/${payment}?cluster=devnet`,
      `claim: https://explorer.solana.com/tx/${gift.claimSignature}?cluster=devnet`,
      `sender: ${sender.publicKey.toBase58()}`,
      `recipient: ${gift.recipientWallet}`,
      `paid: ${price} base units of ${paymentMint}`,
      `raw tNVDA: ${raw}`,
    ].join("\n"),
  );
  await Promise.all([from.context.close(), to.context.close()]);
});
