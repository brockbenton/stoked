/**
 * Refund every expired, unclaimed escrow gift to the treasury. Safe to rerun.
 *   pnpm --filter @stoked/chain escrow:refund
 */
import { PublicKey } from "@solana/web3.js";
import { chainConfigFromEnv } from "../src/index";
import { loadEnv } from "../src/scripts/env";
import { refundExpiredGifts } from "./client";

loadEnv();
const programId = process.env.ESCROW_PROGRAM_ID;
if (!programId) throw new Error("ESCROW_PROGRAM_ID is not set");
const { connection, treasury } = chainConfigFromEnv();
const results = await refundExpiredGifts({ connection, programId: new PublicKey(programId), sender: treasury });
if (results.length === 0) console.log("No expired gifts to refund.");
for (const r of results) console.log(`${r.account.toBase58()}: ${r.state} (${r.signature})`);
if (results.some((r) => r.state !== "confirmed")) process.exit(1);
