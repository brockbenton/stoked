/**
 * Keyboard use, accessible names, 44px targets, reduced motion, and no
 * horizontal scroll at 320px.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { giftUrl, ids, pinClock, settle } from "./helpers";

test.beforeEach(async ({ page }) => {
  await pinClock(page);
});

/** Every visible interactive control is at least 44x44 CSS px. */
async function assertTargets(page: Page) {
  const small = await page.evaluate(() => {
    const els = document.querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type="radio"]), textarea, select, label:has(> input[type="radio"])',
    );
    const out: string[] = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === "hidden") continue;
      if (el.closest(".sr-only")) continue;
      if (r.width < 44 || r.height < 44) {
        out.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
  expect(small, "targets under 44px").toEqual([]);
}

async function assertAxe(page: Page) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, "axe violations").toEqual([]);
}

const screens: Array<{ name: string; go: (page: Page) => Promise<void> }> = [
  { name: "compose", go: async (p) => void (await p.goto("/")) },
  {
    name: "gift sent",
    go: async (p) => {
      await p.addInitScript(() => Object.defineProperty(navigator, "share", { value: async () => {} }));
      await p.goto("/");
      await p.getByLabel("To", { exact: true }).fill("Maya");
      await p.getByLabel("From", { exact: true }).fill("Sam");
      await p.getByRole("button", { name: /^Wrap/ }).click();
      await p.clock.runFor(1000);
      await expect(p.getByRole("button", { name: "Share with Maya" })).toBeVisible();
    },
  },
  {
    name: "wrapped card",
    go: async (p) => {
      await p.goto(giftUrl(ids.wrapped));
      await p.clock.runFor(1000);
    },
  },
  {
    name: "closed sheet",
    go: async (p) => {
      await p.goto(giftUrl(ids.wrapped));
      await p.clock.runFor(1000);
      await p.getByRole("button", { name: /Alex sent you a gift/ }).click();
      await p.clock.runFor(500);
    },
  },
  {
    name: "reveal",
    go: async (p) => {
      await p.goto(giftUrl(ids.opened));
      await p.clock.runFor(1500);
      await expect(p.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
    },
  },
  {
    name: "claimed",
    go: async (p) => {
      await p.goto(giftUrl(ids.claimed));
      await p.clock.runFor(1000);
    },
  },
  {
    name: "wallet",
    go: async (p) => {
      await p.goto("/w");
      await p.clock.runFor(1000);
      await expect(p.getByTestId("holding-tNVDA")).toBeVisible();
    },
  },
  {
    name: "invalid link",
    go: async (p) => {
      await p.goto(giftUrl("00000000-0000-4000-8000-00000000dead"));
      await p.clock.runFor(1000);
    },
  },
];

for (const s of screens) {
  test(`accessible names and contrast (axe): ${s.name}`, async ({ page }) => {
    await s.go(page);
    await assertAxe(page);
  });

  test(`44px targets: ${s.name}`, async ({ page }) => {
    await s.go(page);
    await assertTargets(page);
  });

  test(`no horizontal scroll at 320px: ${s.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await s.go(page);
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      view: window.innerWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.view);
    expect(overflow.body).toBeLessThanOrEqual(overflow.view);
  });
}

test("accessible names on key controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("radio", { name: "NVDA Nvidia" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "$10" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Open now" })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Add a note" })).toBeVisible();
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: "A stock gift inside Alex sent you a gift Tap to unwrap" }).click();
  await expect(page.getByRole("dialog", { name: "Alex sent you a gift" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unwrap the gift" })).toBeVisible();
});

test("keyboard: compose a gift without a pointer", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab"); // To
  await expect(page.getByLabel("To", { exact: true })).toBeFocused();
  await page.keyboard.type("Maya");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("From", { exact: true })).toBeFocused();
  await page.keyboard.type("Sam");
  await page.keyboard.press("Tab"); // stock radio group
  await expect(page.getByRole("radio", { name: "NVDA Nvidia" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "AAPL Apple" })).toBeChecked();
  await page.keyboard.press("Tab"); // amount group
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "$25" })).toBeChecked();
  await page.keyboard.press("Tab"); // note
  await page.keyboard.type("Happy birthday!");
  await page.keyboard.press("Tab"); // when
  await page.keyboard.press("Tab"); // submit
  await expect(page.getByRole("button", { name: "Wrap $25 of Apple" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.clock.runFor(1000);
  await expect(page.getByRole("heading", { name: "Wrapped for Maya" })).toBeVisible();
});

test("keyboard: unwrap and claim without a pointer, focus stays in the sheet", async ({ page }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  const card = page.getByRole("button", { name: /Alex sent you a gift/ });
  await card.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Tab cycles inside the dialog.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.getByRole("button", { name: "Unwrap the gift" }).focus();
  await page.keyboard.press("Enter");
  await page.clock.runFor(2000);
  const claim = page.getByRole("button", { name: "Claim to my wallet" });
  for (let i = 0; i < 8 && !(await claim.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(claim).toBeFocused();
  await page.keyboard.press("Enter");
  await page.clock.runFor(6000);
  await expect(page.getByText("Claimed.")).toBeVisible();
  await expect(page.locator("#gift-notice")).toBeFocused();
});

test("keyboard: Escape closes the sheet and returns focus to the card", async ({ page }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  const card = page.getByRole("button", { name: /Alex sent you a gift/ });
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card).toBeFocused();
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("unwrap is a short crossfade, not the 1.2s animation", async ({ page }) => {
    await page.goto(giftUrl(ids.wrapped));
    await page.clock.runFor(1000);
    await page.getByRole("button", { name: /Alex sent you a gift/ }).click();
    await page.getByRole("button", { name: "Unwrap the gift" }).click();
    const anims = await page.evaluate(() =>
      document.getAnimations().map((a) => ({
        name: (a as CSSAnimation).animationName,
        duration: Number(a.effect?.getTiming().duration ?? 0),
      })),
    );
    expect(anims.map((a) => a.name)).not.toContain("bow-loosen");
    expect(anims.map((a) => a.name)).not.toContain("lid-lift");
    for (const a of anims) expect(a.duration).toBeLessThanOrEqual(250);
    await page.clock.runFor(400);
    await expect(page.getByRole("heading", { name: "$10.00 of Nvidia" })).toBeVisible();
  });
});

test("full motion runs the unwrap animation", async ({ page }) => {
  await page.goto(giftUrl(ids.wrapped));
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: /Alex sent you a gift/ }).click();
  await page.getByRole("button", { name: "Unwrap the gift" }).click();
  const names = await page.evaluate(() => document.getAnimations().map((a) => (a as CSSAnimation).animationName));
  expect(names).toEqual(expect.arrayContaining(["bow-loosen", "lid-lift"]));
});
