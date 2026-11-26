/**
 * The 1:1 flow with nothing mocked: two isolated browser contexts (sender and
 * recipient) against the real API, the real migration and a local validator.
 */
import { expect, test, type Browser, type BrowserContext, type Page, type Request } from "@playwright/test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { deriveMintAddresses, getTokenBalance, parseSecretKey, updateMultiplier } from "@stoked/chain";
import { PublicGift, TICKERS, type Ticker } from "@stoked/shared";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SERVER_LOG } from "../playwright.flow.config";

test.describe.configure({ mode: "serial" });

const connection = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const treasury = parseSecretKey(process.env.TREASURY_SECRET_KEY!);
const mints = deriveMintAddresses(treasury.publicKey);

const balance = (ticker: Ticker, wallet: string) => getTokenBalance(connection, mints[ticker], new PublicKey(wallet));

/** Every request any context made, checked for leaks at the end. */
const requests: { url: string; method: string; body: string; headers: Promise<Record<string, string>> }[] = [];
const tokens: string[] = [];
const wallets: string[] = [];

async function device(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  // Read headers now: they're gone once the context closes. allHeaders includes what the browser adds.
  context.on("request", (r) =>
    requests.push({
      url: r.url(),
      method: r.method(),
      body: r.postData() ?? "",
      headers: r.allHeaders().catch(() => r.headers()),
    }),
  );
  return { context, page: await context.newPage() };
}

async function wrapGift(page: Page, opts: { note: string }): Promise<{ id: string; token: string; link: string }> {
  await page.goto("/");
  await page.getByLabel("To", { exact: true }).fill("Maya");
  await page.getByLabel("From", { exact: true }).fill("Sam");
  await page.getByLabel("Add a note").fill(opts.note);
  await page.getByRole("button", { name: "Wrap $10 of Nvidia" }).click();
  await expect(page.getByRole("heading", { name: "Wrapped for Maya" })).toBeVisible();
  const link = await page.getByLabel("Private gift link").inputValue();
  const url = new URL(link);
  const id = url.pathname.split("/").pop()!;
  const token = new URLSearchParams(url.hash.slice(1)).get("t")!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  tokens.push(token);
  return { id, token, link };
}

async function unwrap(page: Page) {
  await page.getByRole("button", { name: /Sam sent you a gift/ }).click();
  await page.getByRole("button", { name: "Unwrap the gift" }).click();
  await expect(page.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
}

const giftState = async (page: Page, id: string) => PublicGift.parse(await (await page.request.get(`/api/gifts/${id}`)).json());

const isClaimPost = (r: Request) => r.method() === "POST" && r.url().endsWith("/claim");

/** What the browser keeps: the address, and proof the private key can't be exported. */
function storedWallet(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("stoked-wallet");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const stored = await new Promise<{ address: string; keyPair: CryptoKeyPair }>((resolve, reject) => {
      const r = db.transaction("keys").objectStore("keys").get("primary");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    const key = stored.keyPair.privateKey;
    const exports = await Promise.all(
      (["pkcs8", "jwk"] as const).map((format) =>
        crypto.subtle.exportKey(format, key).then(
          () => "exported",
          () => "refused",
        ),
      ),
    );
    return { address: stored.address, algorithm: key.algorithm.name, extractable: key.extractable, exports };
  });
}

test("send, unwrap, swap and claim across two devices", async ({ browser, baseURL }) => {
  const sender = await device(browser, baseURL!);
  const recipient = await device(browser, baseURL!);

  const { id, token, link } = await wrapGift(sender.page, { note: "Happy birthday Maya!" });
  await sender.page.evaluate(() => Object.assign(window, { neverReloaded: true }));

  await recipient.page.goto(link);
  await unwrap(recipient.page);
  await expect(recipient.page.getByText("Happy birthday Maya!")).toBeVisible();
  await expect(sender.page.getByText("Maya opened it and hasn't claimed it yet.")).toBeVisible();

  await recipient.page.getByRole("button", { name: "Swap for a different stock" }).click();
  await recipient.page.getByRole("radio", { name: /AAPL/ }).check();
  await recipient.page.getByRole("button", { name: "Swap to Apple" }).click();
  await expect(recipient.page.getByRole("heading", { name: "$10.00 of Apple" })).toBeVisible();
  await expect(sender.page.getByText("$10.00 of Apple")).toBeVisible();

  await recipient.page.getByRole("button", { name: "Claim to my wallet" }).click();
  await expect(recipient.page.locator("#gift-notice")).toContainText("Claimed.");
  await expect(recipient.page.locator("#gift-notice")).toContainText("in your wallet");
  // The sheet closed: focus lands on the result, not on <body>.
  await expect(recipient.page.locator("#gift-notice")).toBeFocused();

  // The sender's page catches up on its own.
  await expect(sender.page.getByText("Maya claimed it.")).toBeVisible();
  expect(await sender.page.evaluate(() => "neverReloaded" in window)).toBe(true);
  await expect(sender.page.getByLabel("Private gift link")).toHaveCount(0);

  const gift = await giftState(sender.page, id);
  if (gift.status !== "claimed") throw new Error(`expected claimed, got ${gift.status}`);
  expect(gift.ticker).toBe("tAAPL");

  const wallet = await storedWallet(recipient.page);
  wallets.push(wallet.address);
  expect(wallet).toEqual({
    address: gift.recipientWallet,
    algorithm: "Ed25519",
    extractable: false,
    exports: ["refused", "refused"],
  });

  // On chain, against what both screens say.
  const onChain = await balance("tAAPL", wallet.address);
  expect(onChain.raw).toBe(BigInt(gift.tokenRaw));
  expect((await balance("tNVDA", wallet.address)).raw).toBe(0n);
  await expect(recipient.page.locator(".ocard__shares")).toContainText(`≈ ${onChain.shown} AAPL`);
  await expect(sender.page.locator(".ocard__shares")).toContainText(`≈ ${onChain.shown} AAPL`);
  await recipient.page.getByRole("link", { name: "See your wallet" }).click();
  await expect(recipient.page.getByTestId("wallet-address")).toHaveText(wallet.address);
  await expect(recipient.page.getByTestId("holding-tAAPL")).toContainText(onChain.shownExact);
  await expect(recipient.page.locator(".holding")).toHaveCount(1);
  await recipient.page.screenshot({ path: "test-results/flow-screens/wallet.png" });
  await sender.page.screenshot({ path: "test-results/flow-screens/sender-claimed.png", fullPage: true });

  // A multiplier change (a dividend) leaves raw units alone and raises the shares shown.
  await updateMultiplier({ connection, treasury, mint: mints.tAAPL, multiplier: 1.5 });
  const after = await balance("tAAPL", wallet.address);
  expect(after.raw).toBe(onChain.raw);
  expect(after.shownUnits).toBeGreaterThan(onChain.shownUnits);
  await recipient.page.getByRole("button", { name: "Refresh" }).click();
  await expect(recipient.page.getByTestId("holding-tAAPL")).toContainText(after.shownExact);
  await expect(sender.page.locator(".ocard__shares")).toContainText(`≈ ${after.shown} AAPL`);

  // A second claim is refused: in the UI on another device, and by the API.
  const third = await device(browser, baseURL!);
  await third.page.goto(link);
  await expect(third.page.locator("#gift-notice")).toContainText("Already claimed.");
  await expect(third.page.getByRole("button", { name: "Claim to my wallet" })).toHaveCount(0);
  const other = Keypair.generate().publicKey.toBase58();
  const refused = await third.page.request.post(`/api/gifts/${id}/claim`, {
    headers: { authorization: `Bearer ${token}` },
    data: { wallet: other },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("invalid_state");
  expect((await balance("tAAPL", other)).raw).toBe(0n);
  expect((await balance("tAAPL", wallet.address)).raw).toBe(onChain.raw);
  // That device never claimed, so it never made a wallet.
  await third.page.goto("/w");
  await expect(third.page.getByText("There’s no wallet in this browser yet.")).toBeVisible();

  await Promise.all([sender, recipient, third].map((d) => d.context.close()));
});

test("a refresh in the middle of a claim recovers, and pays once", async ({ browser, baseURL }) => {
  const sender = await device(browser, baseURL!);
  const recipient = await device(browser, baseURL!);
  const { id, link } = await wrapGift(sender.page, { note: "Refresh me" });
  await recipient.page.goto(link);
  await unwrap(recipient.page);

  const firstAnswer = recipient.page.waitForResponse((r) => isClaimPost(r.request()));
  await recipient.page.getByRole("button", { name: "Claim to my wallet" }).click();
  expect((await firstAnswer).status()).toBe(202);
  await recipient.page.reload();

  // Nothing but the client moves a pending claim forward, so it is still pending...
  expect((await giftState(sender.page, id)).status).toBe("claiming");
  const resumed = recipient.page.waitForRequest(isClaimPost);
  // ...and the reloaded page finishes it with the same wallet.
  const address = (await storedWallet(recipient.page)).address;
  expect((await resumed).postDataJSON()).toEqual({ wallet: address });
  await expect(recipient.page.locator("#gift-notice")).toContainText("Claimed.");
  await expect(sender.page.getByText("Maya claimed it.")).toBeVisible();
  wallets.push(address);

  const gift = await giftState(sender.page, id);
  if (gift.status !== "claimed") throw new Error(`expected claimed, got ${gift.status}`);
  expect((await balance("tNVDA", address)).raw).toBe(BigInt(gift.tokenRaw));
  const history = await connection.getSignaturesForAddress(new PublicKey(address), {}, "confirmed");
  expect(history.map((h) => h.signature)).toEqual([gift.claimSignature]);

  await Promise.all([sender, recipient].map((d) => d.context.close()));
});

test("the link preview reveals nothing about the gift", async ({ browser, baseURL }) => {
  const sender = await device(browser, baseURL!);
  const previews: Buffer[] = [];
  for (const note of ["secret note one", "a completely different secret"]) {
    const { id } = await wrapGift(sender.page, { note });
    // What a crawler sees: no fragment, no JavaScript.
    const html = await (await sender.page.request.get(`/g/${id}`)).text();
    // (A bare "$10" would match Next's own payload references, so look for the formatted amount.)
    for (const secret of [note, "Nvidia", "NVDA", "$10.00", "usdCents", "tokenRaw", ...TICKERS]) {
      expect(html).not.toContain(secret);
    }
    const image = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];
    expect(image).toBeTruthy();
    const url = new URL(image!.replaceAll("&amp;", "&"));
    expect(url.origin).toBe(baseURL);
    const res = await sender.page.request.get(url.href);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    previews.push(await res.body());
  }
  expect(previews[0]!.equals(previews[1]!)).toBe(true);
  await test.info().attach("link-preview", { body: previews[0]!, contentType: "image/png" });
  mkdirSync("test-results/flow-screens", { recursive: true });
  writeFileSync("test-results/flow-screens/link-preview.png", previews[0]!);
  await sender.context.close();
});

test("the claim token stays out of URLs and logs; the private key is never sent", async () => {
  expect(tokens.length).toBeGreaterThanOrEqual(4);
  const claims = requests.filter((r) => r.method === "POST" && r.url.endsWith("/claim"));
  expect(claims.length).toBeGreaterThanOrEqual(4);

  let withToken = 0;
  for (const request of requests) {
    // A fragment is never sent over HTTP, so drop it before looking.
    const url = new URL(request.url);
    url.hash = "";
    const { authorization, ...rest } = await request.headers;
    const { body } = request;
    for (const token of tokens) {
      expect(url.href).not.toContain(token);
      expect(JSON.stringify(rest)).not.toContain(token);
      expect(body).not.toContain(token);
    }
    if (authorization) {
      withToken += 1;
      expect(url.pathname).toMatch(/^\/api\/gifts\/[0-9a-f-]{36}\/(open|swap|claim)$/);
    }
    // The only things the app ever uploads: the compose form, a ticker, or a public address.
    if (body) {
      expect(url.origin).toBe(new URL(requests[0]!.url).origin);
      const keys = Object.keys(JSON.parse(body) as object).sort().join();
      expect(["note,recipientName,senderName,ticker,usdCents", "ticker", "wallet"]).toContain(keys);
    }
  }
  expect(withToken).toBeGreaterThanOrEqual(claims.length);
  // Nothing left for a third party.
  expect(new Set(requests.map((r) => new URL(r.url).host)).size).toBe(1);
  // Every claim the app sent carried only a public address made on the claiming device.
  expect(wallets).toHaveLength(2);
  for (const claim of claims) expect(wallets).toContain((JSON.parse(claim.body) as { wallet: string }).wallet);

  const log = readFileSync(SERVER_LOG, "utf8");
  expect(log).toContain("Ready"); // the log really is the server's output
  for (const token of tokens) expect(log).not.toContain(token);
  expect(log).not.toContain(process.env.TREASURY_SECRET_KEY!);
});
