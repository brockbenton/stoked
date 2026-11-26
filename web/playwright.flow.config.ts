/**
 * Full flow: browser → real API → PGlite and a local validator. Run it with
 * `pnpm test:flow`, which starts the validator and sets up the mints first.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_FLOW_PORT ?? 3200);
const origin = `http://127.0.0.1:${PORT}`;
export const SERVER_LOG = "test-results/flow-server.log";

if (!process.env.SOLANA_RPC_URL || !process.env.TREASURY_SECRET_KEY) {
  throw new Error("Run via `pnpm test:flow`: it starts the validator and creates a throwaway treasury");
}

export default defineConfig({
  testDir: "./e2e-flow",
  outputDir: "./test-results/flow-artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: origin,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
  webServer: {
    // Everything the server prints goes to the log the tests inspect.
    command: `mkdir -p test-results && pnpm exec next build > ${SERVER_LOG} 2>&1 && exec pnpm exec next start -p ${PORT} -H 127.0.0.1 >> ${SERVER_LOG} 2>&1`,
    url: origin,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_STOKED_CLIENT: "",
      STOKED_LOCAL_DB: "1",
      // Every claim answers 202 first, so the client has to finish it, as on a slow network.
      STOKED_CONFIRM_POLLS: "0",
      APP_ORIGIN: origin,
    },
  },
});
