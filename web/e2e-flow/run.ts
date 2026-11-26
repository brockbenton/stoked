/**
 * Prepare a local validator (already running; see with-validator.ts) with a
 * throwaway treasury and the five mints, then run the full-flow browser tests.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assertSafeCluster, setupMints } from "@stoked/chain";
import { spawn } from "node:child_process";

const url = process.env.SOLANA_RPC_URL;
if (!url) throw new Error("SOLANA_RPC_URL not set: run via `pnpm test:flow`");
const connection = new Connection(url, "confirmed");
if ((await assertSafeCluster(connection)) !== "local") throw new Error("test:flow only runs on a local validator");

const treasury = Keypair.generate();
const signature = await connection.requestAirdrop(treasury.publicKey, 100 * LAMPORTS_PER_SOL);
await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
await setupMints({ connection, treasury });

// Ignore any real devnet settings in the shell: the mints derive from the throwaway key.
const env: NodeJS.ProcessEnv = { ...process.env, TREASURY_SECRET_KEY: JSON.stringify(Array.from(treasury.secretKey)) };
for (const k of Object.keys(env)) if (k.startsWith("MINT_") || k.startsWith("SUPABASE_")) delete env[k];
const child = spawn("playwright", ["test", "-c", "playwright.flow.config.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 1));
