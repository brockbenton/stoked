/**
 * Production wiring from env: Supabase store, Solana chain, in-memory rate
 * limiter. Tests inject their own service with setServiceForTests.
 */
import "server-only";
import { chainConfigFromEnv, createSolanaChain, getRawHoldings, type SolanaChainOptions } from "@stoked/chain";
import { createSolanaEscrow } from "@stoked/chain/escrow";
import { PublicKey } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import { ApiError } from "./errors";
import { localDbClient } from "./local-db";
import { createRateLimiter } from "./rate-limit";
import { createGiftService, type GiftService } from "./service";
import type { GiftStore } from "./store";
import { createSqlGiftStore } from "./store-sql";
import { createSupabaseGiftStore } from "./store-supabase";
import { createWalletService, type WalletService } from "./wallet";

let service: GiftService | undefined;
let walletService: WalletService | undefined;

export function setServiceForTests(s: GiftService | undefined): void {
  service = s;
}

function chainConfig(): SolanaChainOptions & { mints: NonNullable<SolanaChainOptions["mints"]> } {
  try {
    const config = chainConfigFromEnv(process.env);
    return { ...config, mints: config.mints! };
  } catch (err) {
    // For the server log only. These messages name the setting that is wrong, never its value.
    console.error(`[stoked] solana configuration failed: ${err instanceof Error ? err.message : "unknown error"}`);
    throw new ApiError("chain_unavailable", "Server is missing its Solana configuration");
  }
}

/** The local database is for a local validator on a developer machine, never a deployment. */
export function localDbAllowed(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL) return false;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(env.SOLANA_RPC_URL ?? "").hostname);
  } catch {
    return false;
  }
}

/**
 * Escrow settings (docs/escrow.md). ESCROW_PROGRAM_ID makes the server able to
 * claim escrow gifts; STOKED_ESCROW=1 also makes new gifts escrow gifts.
 */
export function escrowSettings(env: Record<string, string | undefined>) {
  const createGifts = env.STOKED_ESCROW === "1";
  const id = env.ESCROW_PROGRAM_ID;
  if (!id) {
    if (createGifts) throw new ApiError("internal", "STOKED_ESCROW needs ESCROW_PROGRAM_ID");
    return undefined;
  }
  try {
    return { programId: new PublicKey(id), createGifts };
  } catch {
    throw new ApiError("internal", "ESCROW_PROGRAM_ID isn't a Solana address");
  }
}

function giftStore(): GiftStore {
  if (process.env.STOKED_LOCAL_DB === "1") {
    if (!localDbAllowed(process.env)) {
      throw new ApiError("internal", "STOKED_LOCAL_DB only works with a local validator");
    }
    return createSqlGiftStore(localDbClient());
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new ApiError("internal", "Server is missing its database configuration");
  return createSupabaseGiftStore(createClient(url, key, { auth: { persistSession: false } }));
}

/** Test knob, honored only with the local database: 0 makes every claim answer 202 first. */
function localConfirmPolls(): number | undefined {
  const v = process.env.STOKED_CONFIRM_POLLS;
  if (process.env.STOKED_LOCAL_DB !== "1" || v === undefined || !/^\d+$/.test(v)) return undefined;
  return Number(v);
}

export function getService(): GiftService {
  if (service) return service;
  const escrow = escrowSettings(process.env);
  const store = giftStore();
  const config = chainConfig();
  service = createGiftService({
    store,
    chain: createSolanaChain(config),
    escrow: escrow && {
      adapter: createSolanaEscrow({ ...config, programId: escrow.programId }),
      createGifts: escrow.createGifts,
    },
    rateLimiter: createRateLimiter({ perKey: 5, global: 100, windowMs: 60_000 }),
    confirmPolls: localConfirmPolls(),
  });
  return service;
}

export function getWalletService(): WalletService {
  if (walletService) return walletService;
  const config = chainConfig();
  const chain = createSolanaChain(config);
  walletService = createWalletService({
    rawHoldings: (wallet) => getRawHoldings(config.connection, config.mints, new PublicKey(wallet)),
    multiplierSchedule: (ticker) => chain.multiplierSchedule(ticker),
    rateLimiter: createRateLimiter({ perKey: 60, global: 300, windowMs: 60_000 }),
  });
  return walletService;
}
