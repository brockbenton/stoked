/**
 * Send with one wallet, claim to another, for real on a local validator. The
 * wallet itself is simulated: a desktop extension that signs in Node, and the
 * phone app behind Phantom's links.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { deriveMintAddresses, getTokenBalance, parseSecretKey } from "@stoked/chain";
import { testPaymentBalance } from "@stoked/chain/test-mint";
import { PublicGift } from "@stoked/shared";
import { AxeBuilder } from "@axe-core/playwright";
import bs58 from "bs58";
import { mkdirSync, readFileSync } from "node:fs";
import { SERVER_LOG } from "../playwright.wallet.config";
import { fakePhantomApp } from "../test/phantom-app";

test.describe.configure({ mode: "serial" });

const connection = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const treasury = parseSecretKey(process.env.TREASURY_SECRET_KEY!);
const sender = parseSecretKey(process.env.WALLET_TEST_SENDER!);
const mint = deriveMintAddresses(treasury.publicKey).tNVDA;
const paymentMint = new PublicKey(process.env.STOKED_PAYMENT_MINT!);

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const RAW = 4_356_918n;
const tokens: string[] = [];
/** Every URL sent to Phantom, checked for the claim token. */
const toPhantom: string[] = [];

const paid = () => testPaymentBalance(connection, paymentMint, sender.publicKey);
const stock = async (owner: string) => (await getTokenBalance(connection, mint, new PublicKey(owner))).raw;
const shot = async (page: Page, name: string) => {
  mkdirSync("test-results/wallet-screens", { recursive: true });
  await page.screenshot({ path: `test-results/wallet-screens/${name}.png`, fullPage: true });
};
const accessible = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

/** Sign like a wallet that adds its own priority fee first. */
function walletSign(transaction: string, key: Keypair): string {
  const tx = Transaction.from(bs58.decode(transaction));
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  tx.partialSign(key);
  return bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/** A desktop browser with an extension holding `key`. */
async function desktop(browser: Browser, baseURL: string, key: Keypair) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  await context.exposeFunction("__walletSign", (bytes: number[]) =>
    Array.from(bs58.decode(walletSign(bs58.encode(Uint8Array.from(bytes)), key))),
  );
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

/**
 * A phone whose links to Phantom are answered by a simulated app. Like iOS, the
 * reply opens in a new tab, which shares only the browser's storage.
 */
async function phone(browser: Browser, baseURL: string, app: ReturnType<typeof fakePhantomApp>) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, userAgent: IPHONE, hasTouch: true });
  const replies: string[] = [];
  await context.route("https://phantom.com/ul/**", async (route) => {
    toPhantom.push(route.request().url());
    replies.push(app.handle(route.request().url()).toString());
    await route.fulfill({ contentType: "text/html", body: "<p>Phantom</p>" });
  });
  /** Tap a link into the app, approve, and follow Phantom back. */
  const approve = async (from: Page, link: string): Promise<Page> => {
    const before = replies.length;
    await from.getByRole("link", { name: link }).click();
    await expect.poll(() => replies.length).toBe(before + 1);
    await from.close();
    const next = await context.newPage();
    await next.goto(replies[before]!);
    return next;
  };
  return { context, page: await context.newPage(), approve };
}

async function fillGift(page: Page, note: string) {
  await page.goto("/");
  await page.getByLabel("To", { exact: true }).fill("Maya");
  await page.getByLabel("From", { exact: true }).fill("Sam");
  await page.getByLabel("Add a note").fill(note);
}

async function readLink(page: Page) {
  await expect(page.getByRole("heading", { name: "Wrapped for Maya" })).toBeVisible();
  const link = await page.getByLabel("Private gift link").inputValue();
  const url = new URL(link);
  const token = new URLSearchParams(url.hash.slice(1)).get("t")!;
  tokens.push(token);
  return { link, id: url.pathname.split("/").pop()!, token };
}

async function unwrap(page: Page) {
  await page.getByRole("button", { name: /Sam sent you a gift/ }).click();
  await page.getByRole("button", { name: "Unwrap the gift" }).click();
  await expect(page.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
}

const state = async (context: BrowserContext, id: string) =>
  PublicGift.parse(await (await context.request.get(`/api/gifts/${id}`)).json());

test("desktop: the sender pays from their wallet and the recipient claims to theirs", async ({ browser, baseURL }) => {
  const before = { paid: await paid(), treasury: await testPaymentBalance(connection, paymentMint, treasury.publicKey) };
  const recipientKey = Keypair.generate();
  const from = await desktop(browser, baseURL!, sender);
  await fillGift(from.page, "Paid for real");
  await expect(from.page.getByRole("button", { name: /^Wrap \$10/ })).toHaveCount(0);
  await accessible(from.page);
  await from.page.getByRole("button", { name: "Connect Phantom" }).click();
  await expect(from.page.getByText(/Paying from Phantom/)).toBeVisible();
  await shot(from.page, "1-compose-connected");
  await from.page.getByRole("button", { name: "Pay 10 USDC and wrap Nvidia" }).click();
  const gift = await readLink(from.page);
  await expect(from.page.getByRole("link", { name: "View the payment on explorer" })).toBeVisible();
  await shot(from.page, "2-wrapped-and-paid");
  expect(await paid()).toBe(before.paid - 10_000_000n);
  expect(await testPaymentBalance(connection, paymentMint, treasury.publicKey)).toBe(before.treasury + 10_000_000n);
  expect(await stock(sender.publicKey.toBase58())).toBe(0n);

  // Reloading keeps the paid link.
  await from.page.reload();
  expect((await readLink(from.page)).link).toBe(gift.link);

  const to = await desktop(browser, baseURL!, recipientKey);
  await to.page.goto(gift.link);
  await unwrap(to.page);
  await expect(to.page.getByRole("button", { name: "Swap for a different stock" })).toHaveCount(0);
  await accessible(to.page);
  await to.page.getByRole("button", { name: "Connect Phantom" }).click();
  await shot(to.page, "3-claim-connected");
  await accessible(to.page);
  await to.page.getByRole("button", { name: "Claim to my Phantom wallet" }).click();
  await expect(to.page.locator("#gift-notice")).toContainText("is in your Phantom wallet");
  await expect(to.page.getByRole("link", { name: "See your wallet on Solana Explorer" })).toBeVisible();
  await shot(to.page, "4-claimed");
  expect(await stock(recipientKey.publicKey.toBase58())).toBe(RAW);
  const claimed = await state(to.context, gift.id);
  expect(claimed).toMatchObject({ status: "claimed", recipientWallet: recipientKey.publicKey.toBase58() });
  await expect(from.page.getByText("Maya claimed it.")).toBeVisible();
  await Promise.all([from.context.close(), to.context.close()]);
});

test("desktop: a recipient without a wallet can still make one", async ({ browser, baseURL }) => {
  const from = await desktop(browser, baseURL!, sender);
  await fillGift(from.page, "No wallet");
  // The last test's context is gone, so this browser starts unconnected.
  await from.page.getByRole("button", { name: "Connect Phantom" }).click();
  await from.page.getByRole("button", { name: "Pay 10 USDC and wrap Nvidia" }).click();
  const gift = await readLink(from.page);

  const context = await browser.newContext({ baseURL: baseURL!, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(gift.link);
  await unwrap(page);
  await expect(page.getByRole("link", { name: "Get Phantom" })).toBeVisible();
  await page.getByRole("button", { name: "Create a wallet here instead" }).click();
  await expect(page.locator("#gift-notice")).toContainText("Claimed.");
  await expect(page.getByRole("link", { name: "See your wallet" })).toBeVisible();
  const claimed = await state(context, gift.id);
  if (claimed.status !== "claimed") throw new Error("expected claimed");
  expect(await stock(claimed.recipientWallet)).toBe(RAW);
  await Promise.all([from.context.close(), context.close()]);
});

test("iPhone: both sides go to the Phantom app and back", async ({ browser, baseURL }) => {
  const before = await paid();
  const senderApp = fakePhantomApp((t) => walletSign(t, sender), sender.publicKey.toBase58());
  const from = await phone(browser, baseURL!, senderApp);
  await fillGift(from.page, "From my phone");
  await from.page.getByRole("radio", { name: /Apple/ }).check({ force: true });
  await from.page.getByRole("radio", { name: /Nvidia/ }).check({ force: true });
  let page = await from.approve(from.page, "Connect Phantom");
  // The form and the connection survived the trip.
  await expect(page.getByLabel("Add a note")).toHaveValue("From my phone");
  await expect(page.getByText(/Paying from Phantom/)).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await page.getByRole("button", { name: "Pay 10 USDC and wrap Nvidia" }).click();
  await shot(page, "5-phone-approve");
  expect(await paid()).toBe(before);
  page = await from.approve(page, "Approve in Phantom");
  const gift = await readLink(page);
  expect(await paid()).toBe(before - 10_000_000n);

  const recipient = Keypair.generate().publicKey.toBase58();
  const to = await phone(browser, baseURL!, fakePhantomApp(undefined, recipient));
  await to.page.goto(gift.link);
  await unwrap(to.page);
  const claim = await to.approve(to.page, "Connect Phantom");
  // The gift is open again, with the claim token back in the address and the reply gone.
  await expect(claim.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
  expect(new URL(claim.url()).hash).toBe(`#t=${gift.token}`);
  expect(new URL(claim.url()).search).toBe("");
  await shot(claim, "6-phone-claim");
  await claim.getByRole("button", { name: "Claim to my Phantom wallet" }).click();
  await expect(claim.locator("#gift-notice")).toContainText("is in your Phantom wallet");
  expect(await stock(recipient)).toBe(RAW);
  // The sender's tab sees it too.
  await expect(page.getByText("Maya claimed it.")).toBeVisible();
  await Promise.all([from.context.close(), to.context.close()]);
});

test("iPhone: declining in Phantom keeps the gift and charges nothing", async ({ browser, baseURL }) => {
  const before = await paid();
  const app = fakePhantomApp((t) => walletSign(t, sender), sender.publicKey.toBase58());
  const from = await phone(browser, baseURL!, app);
  await fillGift(from.page, "Changed my mind");
  const page = await from.approve(from.page, "Connect Phantom");
  await page.getByRole("button", { name: "Pay 10 USDC and wrap Nvidia" }).click();
  await expect(page.getByRole("link", { name: "Approve in Phantom" })).toBeVisible();
  // Phantom answers a refusal with an error instead of data.
  await page.getByRole("link", { name: "Approve in Phantom" }).evaluate((a) => a.addEventListener("click", (e) => e.preventDefault()));
  await page.getByRole("link", { name: "Approve in Phantom" }).click();
  await page.goto("/?phantom=sign&errorCode=4001&errorMessage=rejected");
  await expect(page.getByText("You declined in Phantom")).toBeVisible();
  await expect(page.getByText(/Paying from Phantom/)).toBeVisible();
  expect(await paid()).toBe(before);

  // A reply this browser didn't ask for is ignored.
  await page.goto("/g/00000000-0000-4000-8000-000000000000?phantom=connect&data=x");
  await expect(page.getByText("doesn't recognise")).toBeVisible();
  await from.context.close();
});

test("the claim token reaches neither Phantom nor the server log", async () => {
  expect(tokens.length).toBeGreaterThan(0);
  expect(toPhantom.length).toBeGreaterThan(0);
  const log = readFileSync(SERVER_LOG, "utf8");
  for (const token of tokens) {
    for (const url of toPhantom) expect(decodeURIComponent(url)).not.toContain(token);
    expect(log).not.toContain(token);
  }
});
