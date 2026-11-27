/**
 * Wallet-paid gifts: browser → real API → PGlite and a local validator running
 * the escrow program. Run it with `pnpm test:wallet`.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_WALLET_PORT ?? 3300);
const origin = `http://127.0.0.1:${PORT}`;
export const SERVER_LOG = "test-results/wallet-server.log";

if (!process.env.SOLANA_RPC_URL || !process.env.STOKED_PAYMENT_MINT) {
  throw new Error("Run via `pnpm test:wallet`: it starts the validator and creates the test tokens");
}

export default defineConfig({
  testDir: "./e2e-wallet",
  testMatch: "*.spec.ts",
  outputDir: "./test-results/wallet-artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 45_000 },
  reporter: [["list"]],
  use: {
    baseURL: origin,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
  webServer: {
    command: `mkdir -p test-results && pnpm exec next build > ${SERVER_LOG} 2>&1 && exec pnpm exec next start -p ${PORT} -H 127.0.0.1 >> ${SERVER_LOG} 2>&1`,
    url: origin,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_STOKED_CLIENT: "",
      STOKED_LOCAL_DB: "1",
      // Claims and payments answer "pending" first, so the client has to finish them.
      STOKED_CONFIRM_POLLS: "0",
      APP_ORIGIN: origin,
    },
  },
});
