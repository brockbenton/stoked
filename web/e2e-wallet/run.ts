/**
 * Prepare a local validator running the escrow program (see with-validator.ts)
 * with a throwaway treasury, the five mints and a stand-in payment token, then
 * run the wallet browser tests.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assertSafeCluster, setupMints } from "@stoked/chain";
import { createTestPaymentMint, mintTestPayment } from "@stoked/chain/test-mint";
import { spawn } from "node:child_process";

const url = process.env.SOLANA_RPC_URL;
if (!url || !process.env.ESCROW_PROGRAM_ID) throw new Error("run via `pnpm test:wallet`");
const connection = new Connection(url, "confirmed");
if ((await assertSafeCluster(connection)) !== "local") throw new Error("test:wallet only runs on a local validator");

const treasury = Keypair.generate();
const sender = Keypair.generate();
for (const [who, sol] of [[treasury, 100], [sender, 2]] as const) {
  const signature = await connection.requestAirdrop(who.publicKey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
}
await setupMints({ connection, treasury });
const paymentMint = await createTestPaymentMint(connection, treasury);
await mintTestPayment(connection, treasury, paymentMint, sender.publicKey, 100_000_000n);

// Ignore any real devnet settings in the shell: everything derives from the throwaway keys.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  TREASURY_SECRET_KEY: JSON.stringify(Array.from(treasury.secretKey)),
  STOKED_PAYMENT_MINT: paymentMint.toBase58(),
  WALLET_TEST_SENDER: JSON.stringify(Array.from(sender.secretKey)),
};
for (const k of Object.keys(env)) if (k.startsWith("MINT_") || k.startsWith("SUPABASE_")) delete env[k];
const child = spawn("playwright", ["test", "-c", "playwright.wallet.config.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 1));
