/** Regression tests for review findings on the gift screen state machine. */
import { expect, test, type Page } from "@playwright/test";
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

test("an escrow gift offers no swap", async ({ page }) => {
  await page.goto(giftUrl(ids.opened, { sim: "escrow" }));
  await page.clock.runFor(1000);
  await expect(page.getByRole("button", { name: "Claim to my wallet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Swap for a different stock" })).toHaveCount(0);
});

for (const key of ["opened", "claiming"] as const) {
  test(`an expired gift says so and offers no retry (${key})`, async ({ page }) => {
    await page.goto(giftUrl(ids[key], { sim: "claim-expired" }));
    await page.clock.runFor(1000);
    if (key === "opened") await page.getByRole("button", { name: "Claim to my wallet" }).click();
    await page.clock.runFor(3000);
    const alert = page.locator(".notice--error");
    await expect(alert).toContainText("This gift has expired.");
    await expect(alert).toBeFocused();
    for (const name of ["Try again", "Check again", "Claim to my wallet", "Swap for a different stock"]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
  });
}

test("an open date more than a year ahead is explained on the field", async ({ page }) => {
  await page.goto("/");
  await page.clock.runFor(1000);
  await page.getByLabel("To", { exact: true }).fill("Maya");
  await page.getByLabel("From", { exact: true }).fill("Alex");
  await page.getByRole("radio", { name: "Pick a time" }).check();
  await page.getByLabel("Opens at").fill("2029-01-01T10:00");
  await page.getByRole("button", { name: /^Wrap/ }).click();
  await expect(page.getByText("Pick a time within the next year")).toBeVisible();
  await expect(page.getByLabel("Opens at")).toBeFocused();
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

test.describe("sharing the gift link", () => {
  type Shared = Window & { shared: ShareData[] };

  /** Replaces the share sheet: records what it was given, or rejects with a named error. */
  const stubShare = (page: Page, rejectWith: string | null) =>
    page.addInitScript((name) => {
      (window as unknown as Shared).shared = [];
      Object.defineProperty(navigator, "share", {
        value: name === "absent" ? undefined : async (data: ShareData) => {
          (window as unknown as Shared).shared.push(data);
          if (name) throw new DOMException("stub", name);
        },
      });
    }, rejectWith);

  async function wrap(page: Page) {
    await page.goto("/");
    await page.getByLabel("To", { exact: true }).fill("Maya");
    await page.getByLabel("From", { exact: true }).fill("Sam");
    await page.getByRole("button", { name: /^Wrap/ }).click();
    await page.clock.runFor(1000);
    await expect(page.getByRole("heading", { name: "Wrapped for Maya" })).toBeVisible();
  }

  const failure = (page: Page) => page.getByText("Couldn’t open sharing. Copy the link instead.");

  test("Share hands the private link, and nothing else, to the share sheet", async ({ page }) => {
    await stubShare(page, null);
    await wrap(page);
    const link = await page.getByLabel("Private gift link").inputValue();
    await page.getByRole("button", { name: "Share with Maya" }).click();
    expect(await page.evaluate(() => (window as unknown as Shared).shared)).toEqual([{ url: link }]);
    await expect(failure(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy" })).toHaveClass(/btn--secondary/);
  });

  test("closing the share sheet is not an error", async ({ page }) => {
    await stubShare(page, "AbortError");
    await wrap(page);
    await page.getByRole("button", { name: "Share with Maya" }).click();
    await page.clock.runFor(500);
    expect(await page.evaluate(() => (window as unknown as Shared).shared.length)).toBe(1);
    await expect(failure(page)).toHaveCount(0);
  });

  test("a share sheet that fails points to the link", async ({ page }) => {
    await stubShare(page, "NotAllowedError");
    await wrap(page);
    await page.getByRole("button", { name: "Share with Maya" }).click();
    await expect(failure(page)).toBeVisible();
    await expect(page.getByLabel("Private gift link")).toBeVisible();
  });

  test("without a share sheet, Copy is the main action", async ({ page }) => {
    await stubShare(page, "absent");
    await wrap(page);
    await expect(page.getByRole("button", { name: /^Share/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy" })).toHaveClass(/btn--primary/);
    await expect(page.getByRole("link", { name: "Open it as Maya" })).toBeVisible();
  });
});

test.describe("the app's own link", () => {
  test("has icons and its own preview; a gift link keeps the wrapped one", async ({ page, request }) => {
    const meta = (html: string, property: string) =>
      new RegExp(`<meta property="${property}" content="([^"]*)"`).exec(html)?.[1]?.replaceAll("&amp;", "&");
    const home = await (await request.get("/")).text();
    const gift = await (await request.get(giftUrl(ids.wrapped, { token: false }))).text();
    expect(meta(home, "og:title")).toBe("Stoked");
    expect(meta(gift, "og:title")).toBe("You got a gift · Stoked");
    expect(meta(home, "og:image:alt")).toBe("Stoked. Send a stock gift.");
    expect(meta(gift, "og:image:alt")).toBe("A wrapped stock gift. Open the link to unwrap it.");
    for (const html of [home, gift]) {
      const image = new URL(meta(html, "og:image")!);
      const res = await request.get(image.pathname + image.search);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("image/png");
    }
    await page.goto("/");
    for (const rel of ["icon", "apple-touch-icon"]) {
      const links = page.locator(`link[rel="${rel}"]`);
      expect(await links.count()).toBeGreaterThan(0);
      for (const href of await links.evaluateAll((els) => els.map((e) => e.getAttribute("href")!))) {
        expect((await request.get(href)).status()).toBe(200);
      }
    }
  });
});
