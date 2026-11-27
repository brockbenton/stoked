/**
 * Start a throwaway solana-test-validator, run the given command against it
 * with SOLANA_RPC_URL set, then shut it down. Exit code is the command's.
 *   tsx scripts/with-validator.ts vitest run -c vitest.validator.config.ts
 * With --escrow first, the validator also loads the compiled escrow program
 * (`cargo build-sbf` in programs/escrow) and ESCROW_PROGRAM_ID is set.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ESCROW_PROGRAM_ID } from "../escrow/program";

const args = process.argv.slice(2);
const escrow = args[0] === "--escrow";
const cmd = escrow ? args.slice(1) : args;
if (cmd.length === 0) throw new Error("usage: with-validator [--escrow] <command...>");
const programSo = join(import.meta.dirname, "../../../programs/escrow/target/deploy/stoked_escrow.so");
if (escrow && !existsSync(programSo)) {
  throw new Error("escrow program not built: run `cargo build-sbf` in programs/escrow");
}

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
    ...(escrow ? ["--bpf-program", ESCROW_PROGRAM_ID.toBase58(), programSo] : []),
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
      env: { ...process.env, SOLANA_RPC_URL: url, ...(escrow ? { ESCROW_PROGRAM_ID: ESCROW_PROGRAM_ID.toBase58() } : {}) },
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
} finally {
  cleanup();
}
process.exit(code);
