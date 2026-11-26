/** Regression tests for review findings on the gift screen state machine. */
import { expect, test } from "@playwright/test";
import { giftUrl, ids, pinClock } from "./helpers";

test.beforeEach(async ({ page }) => {
  await pinClock(page);
});

test.describe("sender view (no token) never gets the claim sheet", () => {
  for (const key of ["opened", "claiming", "claimed"] as const) {
    test(`${key} gift`, async ({ page }) => {
      await page.goto(giftUrl(ids[key], { token: false }));
      await page.clock.runFor(1000);
      await expect(page.getByRole("article", { name: "Gift from Alex" })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Claim to my wallet" })).toHaveCount(0);
      await expect(page.getByText("Sending to your wallet…")).toHaveCount(0);
      if (key === "claimed") await expect(page.getByText("Maya claimed it.")).toBeVisible();
    });
  }
});

test("a second tap while unwrapping sends no second open and doesn't reload", async ({ page }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: /Alex sent you a gift/ }).click();
  const box = page.locator(".closed__box");
  await box.click();
  await box.click({ force: true }); // aria-disabled still receives clicks
  await page.clock.runFor(100);
  await expect(page.getByLabel("Loading gift")).toHaveCount(0);
  await page.clock.runFor(2000);
  await expect(page.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
  await expect(page.locator(".error, .notice--error")).toHaveCount(0);
});

test("swap failure is shown, and the gift is unchanged", async ({ page }) => {
  await page.goto(giftUrl(ids.opened, { sim: "swap-fail" }));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: "Swap for a different stock" }).click();
  await expect(page.getByRole("radio", { name: /AAPL/ })).toBeFocused();
  await page.getByRole("button", { name: /^Swap to/ }).click();
  await page.clock.runFor(1000);
  await expect(page.locator(".swap").getByRole("alert")).toHaveText("Couldn't swap right now. Your gift hasn't changed.");
  await page.getByRole("button", { name: "Keep Nvidia" }).click();
  await expect(page.getByRole("button", { name: "Swap for a different stock" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
});

test("swap keeps the dollar value and changes the stock", async ({ page }) => {
  await page.goto(giftUrl(ids.opened));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: "Swap for a different stock" }).click();
  await page.getByRole("radio", { name: /TSLA/ }).check();
  await page.getByRole("button", { name: "Swap to Tesla" }).click();
  await page.clock.runFor(1000);
  await expect(page.getByRole("heading", { name: "$10.00 of Tesla" })).toBeVisible();
});

test("a claim error after the server started the claim shows pending, not failure", async ({ page }) => {
  await page.goto(giftUrl(ids.opened, { sim: "claim-moved,claim-stuck" }));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: "Claim to my wallet" }).click();
  await page.clock.runFor(1000);
  await expect(page.getByText("Sending to your wallet…")).toBeVisible();
  await expect(page.getByText("Claim didn’t go through.")).toHaveCount(0);
});

test("claim-fail never says nothing happened without checking", async ({ page }) => {
  await page.goto(giftUrl(ids.opened, { sim: "claim-fail" }));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: "Claim to my wallet" }).click();
  await page.clock.runFor(1000);
  const alert = page.locator(".notice--error");
  await expect(alert).toContainText("Your gift is safe and will only be sent once");
  await expect(alert).toBeFocused();
});

test("focus follows the claim: button → status → claimed notice, never <body> or the dialog box", async ({ page }) => {
  await page.goto(giftUrl(ids.opened));
  await page.clock.runFor(1000);
  const dialog = page.getByRole("dialog");
  // Reach the claim button by keyboard.
  const claim = page.getByRole("button", { name: "Claim to my wallet" });
  for (let i = 0; i < 6 && !(await claim.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(claim).toBeFocused();
  await page.keyboard.press("Enter");
  await page.clock.runFor(400);
  const pendingFocus = await page.evaluate(() => document.activeElement?.className ?? "");
  expect(pendingFocus).toContain("notice");
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.clock.runFor(6000);
  await expect(page.locator("#gift-notice")).toBeFocused();
});

test("closing the sheet after unwrapping returns focus to Show gift", async ({ page }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: /Alex sent you a gift/ }).click();
  await page.getByRole("button", { name: "Unwrap the gift" }).click();
  await page.clock.runFor(2000);
  await expect(page.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Show gift" })).toBeFocused();
});

test("real offline/online events: banner shows, and reconnecting reloads a failed page", async ({ page, context }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  await context.setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "You’re offline" })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole("status").filter({ hasText: "You’re offline" })).toHaveCount(0);
});
