import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  // Screenshots go to test-results/screens; Playwright's own artifacts (cleaned each run) go here.
  outputDir: "./test-results/artifacts",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    hasTouch: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 } }],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  },
});
