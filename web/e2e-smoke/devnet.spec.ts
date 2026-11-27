/**
 * Create, unwrap and claim one gift on a deployment, then check the transfer
 * on devnet by RPC rather than trusting what the app says.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { Connection, PublicKey, type TokenBalance } from "@solana/web3.js";
import { assertSafeCluster, deriveMintAddresses } from "@stoked/chain";
import { PublicGift } from "@stoked/shared";

const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const treasury = new PublicKey(process.env.SMOKE_TREASURY_ADDRESS!);
const mint = deriveMintAddresses(treasury).tNVDA.toBase58();

/** Gets past Vercel's login on preview deployments. Empty for a public URL. */
const access: Record<string, string> = process.env.VERCEL_OIDC_TOKEN
  ? { "x-vercel-trusted-oidc-idp-token": process.env.VERCEL_OIDC_TOKEN }
  : {};

async function device(browser: Browser, baseURL: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const { origin } = new URL(baseURL);
  // Only the deployment under test is sent the access token.
  await context.route(
    (url) => url.origin === origin,
    (route) => route.continue({ headers: { ...route.request().headers(), ...access } }),
  );
  return context.newPage();
}

const rawOf = (balances: TokenBalance[] | null | undefined, owner: string) =>
  BigInt(balances?.find((b) => b.owner === owner && b.mint === mint)?.uiTokenAmount.amount ?? "0");

test("create, unwrap and claim a gift on devnet", async ({ browser, baseURL }) => {
  expect(await assertSafeCluster(connection)).toBe("devnet");
  console.log(`genesis hash: ${await connection.getGenesisHash()} (devnet)`);

  const sender = await device(browser, baseURL!);
  await sender.goto("/");
  await sender.getByLabel("To", { exact: true }).fill("Maya");
  await sender.getByLabel("From", { exact: true }).fill("Sam");
  await sender.getByLabel("Add a note").fill("Devnet smoke test");
  await sender.getByRole("button", { name: "Wrap $10 of Nvidia" }).click();
  await expect(sender.getByRole("heading", { name: "Wrapped for Maya" })).toBeVisible();
  const link = await sender.getByLabel("Private gift link").inputValue();
  expect(new URL(link).origin).toBe(new URL(baseURL!).origin);
  const id = new URL(link).pathname.split("/").pop()!;

  const recipient = await device(browser, baseURL!);
  await recipient.goto(link);
  await recipient.getByRole("button", { name: /Sam sent you a gift/ }).click();
  await recipient.getByRole("button", { name: "Unwrap the gift" }).click();
  await expect(recipient.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
  await recipient.getByRole("button", { name: "Claim to my wallet" }).click();
  await expect(recipient.locator("#gift-notice")).toContainText("Claimed.", { timeout: 180_000 });
  await expect(sender.getByText("Maya claimed it.")).toBeVisible();

  const res = await sender.request.get(`/api/gifts/${id}`, { headers: access });
  const gift = PublicGift.parse(await res.json());
  if (gift.status !== "claimed") throw new Error(`expected claimed, got ${gift.status}`);
  expect(gift.ticker).toBe("tNVDA");

  const lookup = () =>
    connection.getParsedTransaction(gift.claimSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  await expect.poll(async () => (await lookup()) !== null).toBe(true);
  const meta = (await lookup())!.meta!;
  expect(meta.err).toBeNull();
  const expected = BigInt(gift.tokenRaw);
  const recipientGain = rawOf(meta.postTokenBalances, gift.recipientWallet) - rawOf(meta.preTokenBalances, gift.recipientWallet);
  const treasuryLoss =
    rawOf(meta.preTokenBalances, treasury.toBase58()) - rawOf(meta.postTokenBalances, treasury.toBase58());
  expect(recipientGain).toBe(expected);
  expect(treasuryLoss).toBe(expected);

  await recipient.getByRole("link", { name: "See your wallet" }).click();
  await expect(recipient.getByTestId("wallet-address")).toHaveText(gift.recipientWallet);
  await expect(recipient.getByTestId("holding-tNVDA")).toBeVisible();
  await recipient.screenshot({ path: "test-results/smoke-screens/wallet.png", fullPage: true });

  console.log(
    [
      `signature: ${gift.claimSignature}`,
      `mint (tNVDA): ${mint}`,
      `recipient: ${gift.recipientWallet}`,
      `raw amount: ${recipientGain} (expected ${expected})`,
      `price source: ${gift.value.priceSource}`,
      `https://explorer.solana.com/tx/${gift.claimSignature}?cluster=devnet`,
    ].join("\n"),
  );

  await Promise.all([sender, recipient].map((p) => p.context().close()));
});
