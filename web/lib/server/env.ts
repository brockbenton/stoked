/**
 * Production wiring from env: Supabase store, Solana chain, in-memory rate
 * limiter. Tests inject their own service with setServiceForTests.
 */
import "server-only";
import { chainConfigFromEnv, createSolanaChain } from "@stoked/chain";
import { createClient } from "@supabase/supabase-js";
import { ApiError } from "./errors";
import { createRateLimiter } from "./rate-limit";
import { createGiftService, type GiftService } from "./service";
import { createSupabaseGiftStore } from "./store-supabase";

let service: GiftService | undefined;

export function setServiceForTests(s: GiftService | undefined): void {
  service = s;
}

export function getService(): GiftService {
  if (service) return service;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new ApiError("internal", "Server is missing its database configuration");
  let chain;
  try {
    chain = createSolanaChain(chainConfigFromEnv(process.env));
  } catch {
    throw new ApiError("chain_unavailable", "Server is missing its Solana configuration");
  }
  service = createGiftService({
    store: createSupabaseGiftStore(createClient(url, key, { auth: { persistSession: false } })),
    chain,
    rateLimiter: createRateLimiter({ perKey: 5, global: 100, windowMs: 60_000 }),
  });
  return service;
}
