import type { Page } from "@playwright/test";
import { fixtures } from "@stoked/shared";

export const TOKEN = "fixture-token-for-ui-tests-0000000000";
export const ids = Object.fromEntries(Object.entries(fixtures).map(([k, g]) => [k, g.id])) as Record<
  keyof typeof fixtures,
  string
>;

export const giftUrl = (id: string, opts: { token?: boolean; sim?: string } = {}) =>
  `/g/${id}${opts.sim ? `?sim=${opts.sim}` : ""}${opts.token === false ? "" : `#t=${TOKEN}`}`;

/** Wait for finite CSS animations (sheet slide, reveal fade) to finish. */
export async function settle(page: Page) {
  // The page clock is faked (timers and rAF), so pause on the test side. Loop because a
  // render can start new animations (e.g. the reveal fade) after the first wait.
  for (let round = 0; round < 6; round++) {
    await page.waitForTimeout(60);
    const waited = await page.evaluate(async () => {
      const running = document
        .getAnimations()
        .filter((a) => a.playState === "running" && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)));
      await Promise.all(running.map((a) => a.finished.catch(() => undefined)));
      return running.length;
    });
    if (waited === 0) return;
  }
}

export async function screenshot(page: Page, name: string, opts: { settle?: boolean } = {}) {
  if (opts.settle !== false) await settle(page);
  await page.screenshot({ path: `test-results/screens/${name}.png`, animations: "allow" });
}

/** Fixtures are dated Nov 28, 2026; pin the clock so "opens at" logic is stable. */
export async function pinClock(page: Page) {
  await page.clock.install({ time: new Date("2026-11-28T15:10:00.000Z") });
}
