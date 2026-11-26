/**
 * Start a throwaway solana-test-validator, run the given command against it
 * with SOLANA_RPC_URL set, then shut it down. Exit code is the command's.
 *   tsx scripts/with-validator.ts vitest run -c vitest.validator.config.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cmd = process.argv.slice(2);
if (cmd.length === 0) throw new Error("usage: with-validator <command...>");

const base = 20000 + Math.floor(Math.random() * 20000);
const rpcPort = base;
const ledger = mkdtempSync(join(tmpdir(), "stoked-ledger-"));
const validator = spawn(
  "solana-test-validator",
  [
    "--reset",
    "--quiet",
    "--ledger",
    ledger,
    "--rpc-port",
    String(rpcPort),
    "--faucet-port",
    String(base + 2),
    "--gossip-port",
    String(base + 3),
    "--dynamic-port-range",
    `${base + 10}-${base + 60}`,
    "--bind-address",
    "127.0.0.1",
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
const url = `http://127.0.0.1:${rpcPort}`;

function cleanup() {
  validator.kill("SIGTERM");
  rmSync(ledger, { recursive: true, force: true });
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function waitHealthy(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (validator.exitCode !== null) throw new Error(`validator exited with ${validator.exitCode}`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      });
      const body = (await res.json()) as { result?: string };
      if (body.result === "ok") return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("validator did not become healthy");
}

let code: number;
try {
  await waitHealthy();
  console.log(`solana-test-validator ready at ${url}`);
  code = await new Promise<number>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      stdio: "inherit",
      env: { ...process.env, SOLANA_RPC_URL: url },
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
} finally {
  cleanup();
}
process.exit(code);
