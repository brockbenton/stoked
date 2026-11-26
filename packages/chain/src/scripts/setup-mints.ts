/**
 * Idempotent mint setup: pnpm --filter @stoked/chain setup:mints
 * Prints public mint addresses only, as MINT_* lines for .env.
 */
import { chainConfigFromEnv, MINT_ENV, setupMints } from "../index";
import { loadEnv } from "./env";

loadEnv();
const { connection, treasury } = chainConfigFromEnv();
// Host only: hosted RPC URLs often carry an API key in the path or query.
console.log(`treasury ${treasury.publicKey.toBase58()} on ${new URL(connection.rpcEndpoint).host}`);
const results = await setupMints({ connection, treasury });
for (const r of results) {
  console.log(`${r.ticker}: ${r.actions.length ? r.actions.join(", ") : "already set up"}`);
}
console.log("\n# Add to .env");
for (const r of results) console.log(`${MINT_ENV[r.ticker]}=${r.mint.toBase58()}`);
