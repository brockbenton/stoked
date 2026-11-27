/**
 * Smoke test against a deployment that runs on devnet. It creates a real gift
 * there and spends a little treasury SOL. See docs/devnet.md.
 */
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.SMOKE_BASE_URL;
if (!baseURL || !process.env.SMOKE_TREASURY_ADDRESS) {
  throw new Error("Set SMOKE_BASE_URL (the deployment) and SMOKE_TREASURY_ADDRESS (public address)");
}

export default defineConfig({
  testDir: "./e2e-smoke",
  outputDir: "./test-results/smoke-artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  // Public devnet confirms more slowly than a local validator.
  expect: { timeout: 90_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    // A trace would save the access token and the claim token to disk.
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
});
