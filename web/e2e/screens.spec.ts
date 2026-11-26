/**
 * One 390x844 screenshot per screen and state, saved to test-results/screens
 * for comparison with mockups/png.
 */
import { expect, test } from "@playwright/test";
import { giftUrl, ids, pinClock, screenshot } from "./helpers";

test.beforeEach(async ({ page }) => {
  await pinClock(page);
});

test("01 compose", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("To", { exact: true }).fill("Maya");
  await page.getByLabel("From", { exact: true }).fill("Sam");
  await page.getByLabel("Add a note").fill("Happy birthday Maya!");
  await expect(page.getByRole("button", { name: "Wrap $10 of Nvidia" })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await screenshot(page, "01-compose");
});

test("01b compose sent (sender's wrapped card)", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("To", { exact: true }).fill("Maya");
  await page.getByLabel("From", { exact: true }).fill("Sam");
  await page.getByRole("button", { name: /^Wrap/ }).click();
  await page.clock.runFor(1000);
  await expect(page.getByRole("heading", { name: "Wrapped for Maya" })).toBeVisible();
  await screenshot(page, "01b-compose-sent");
});

test("02 wrapped card", async ({ page }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  await expect(page.getByRole("button", { name: /Alex sent you a gift/ })).toBeVisible();
  await screenshot(page, "02-wrapped-card");
});

test("03a closed", async ({ page }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: /Alex sent you a gift/ }).click();
  await expect(page.getByRole("button", { name: "Unwrap the gift" })).toBeVisible();
  await page.clock.runFor(500);
  await screenshot(page, "03a-closed");
});

test("03 unwrap animation (mid-frame)", async ({ page }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: /Alex sent you a gift/ }).click();
  await page.clock.runFor(500);
  await page.getByRole("button", { name: "Unwrap the gift" }).click();
  await page.clock.runFor(300); // deliver the open response so the amount is mounted
  await expect(page.locator(".closed__amount")).toBeAttached();
  // Freeze a frame: lid mid-lift, box falling away, amount resolving.
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = (a as CSSAnimation).animationName === "amount-resolve" ? 1000 : 850;
    }
  });
  await screenshot(page, "03-unwrap-animation", { settle: false });
});

test("03b reveal", async ({ page }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: /Alex sent you a gift/ }).click();
  await page.getByRole("button", { name: "Unwrap the gift" }).click();
  await page.clock.runFor(2000);
  await expect(page.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
  await page.clock.runFor(1000);
  await screenshot(page, "03b-reveal");
});

test("03c swap picker", async ({ page }) => {
  await page.goto(giftUrl(ids.opened));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: "Swap for a different stock" }).click();
  await expect(page.getByRole("radio", { name: /AAPL/ })).toBeChecked();
  await screenshot(page, "03c-swap");
});

test("04 claimed card", async ({ page }) => {
  await page.goto(giftUrl(ids.opened));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: "Claim to my wallet" }).click();
  await page.clock.runFor(6000);
  await expect(page.getByText("Claimed.")).toBeVisible();
  await screenshot(page, "04-claimed");
});

test.describe("states the mockups don't show", () => {
  test("loading", async ({ page }) => {
    await page.goto(giftUrl(ids.wrapped, { sim: "slow" }));
    await expect(page.getByLabel("Loading gift")).toBeVisible();
    await screenshot(page, "state-loading");
  });

  test("not openable yet", async ({ page }) => {
    await page.goto(giftUrl(ids.wrappedScheduled));
    await page.clock.runFor(1000);
    await page.getByRole("button", { name: /Alex sent you a gift/ }).click();
    await expect(page.getByRole("button", { name: /locked until it opens/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText(/It opens Fri, Dec 25/)).toBeVisible();
    await page.clock.runFor(500);
    await screenshot(page, "state-not-openable-yet");
  });

  test("claim pending (retryable)", async ({ page }) => {
    await page.goto(giftUrl(ids.claiming, { sim: "claim-stuck" }));
    await page.clock.runFor(1000);
    await expect(page.getByText("Sending to your wallet…")).toBeVisible();
    await page.clock.runFor(12_000);
    await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
    await screenshot(page, "state-claim-pending");
  });

  test("already claimed", async ({ page }) => {
    await page.goto(giftUrl(ids.claimed));
    await page.clock.runFor(1000);
    await expect(page.getByText("Already claimed.")).toBeVisible();
    await screenshot(page, "state-already-claimed");
  });

  test("claim failed", async ({ page }) => {
    await page.goto(giftUrl(ids.opened, { sim: "claim-fail" }));
    await page.clock.runFor(1000);
    await page.getByRole("button", { name: "Claim to my wallet" }).click();
    await page.clock.runFor(1000);
    await expect(page.getByRole("alert").filter({ hasText: "Claim didn’t go through." })).toBeVisible();
    await screenshot(page, "state-claim-failed");
  });

  test("invalid link", async ({ page }) => {
    await page.goto(giftUrl("00000000-0000-4000-8000-00000000dead"));
    await page.clock.runFor(1000);
    await expect(page.getByRole("heading", { name: "This gift link doesn’t work" })).toBeVisible();
    await screenshot(page, "state-invalid-link");
  });

  test("offline", async ({ page, context }) => {
    await page.goto(giftUrl(ids.wrapped, { sim: "offline" }));
    await context.setOffline(true);
    await page.clock.runFor(1000);
    await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "You’re offline" })).toBeVisible();
    await screenshot(page, "state-offline");
    await context.setOffline(false);
  });

  test("sender view (no token)", async ({ page }) => {
    await page.goto(giftUrl(ids.wrapped, { token: false }));
    await page.clock.runFor(1000);
    await expect(page.getByText(/Only the private link Maya received/)).toBeVisible();
    await screenshot(page, "state-sender-view");
  });
});
