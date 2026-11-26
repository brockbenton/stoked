import "server-only";
import { ApiError } from "./errors";
import { getService, getWalletService } from "./env";
import type { GiftService } from "./service";
import { bearerToken } from "./tokens";
import type { WalletService } from "./wallet";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Request validation is turned into ApiError("validation_failed") inside the
 * service, so anything else that throws (including a ZodError from checking
 * our own output) is a server fault: 500 with no internals echoed.
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return json({ error: { code: err.code, message: err.message } }, err.status);
  console.error("[stoked] api error:", err instanceof Error ? err.name : typeof err);
  return json({ error: { code: "internal", message: "Something went wrong" } }, 500);
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("bad_request", "Body must be JSON");
  }
}

export const tokenOf = (req: Request) => bearerToken(req.headers.get("authorization"));

/**
 * Client IP for the per-client limiter. Prefers headers the platform sets
 * (Vercel overwrites x-vercel-forwarded-for / x-real-ip); the leftmost
 * x-forwarded-for entry is client-controlled behind appending proxies, so it
 * is the last resort. The durable global cap backs this up either way.
 */
export function clientKey(req: Request): string {
  const h = req.headers;
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  return first(h.get("x-vercel-forwarded-for")) ?? first(h.get("x-real-ip")) ?? first(h.get("x-forwarded-for")) ?? "unknown";
}

/** Run a handler against the service, mapping errors to `{ error: { code, message } }`. */
export async function handle(fn: (service: GiftService) => Promise<Response>): Promise<Response> {
  try {
    return await fn(getService());
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleWallet(fn: (service: WalletService) => Promise<Response>): Promise<Response> {
  try {
    return await fn(getWalletService());
  } catch (err) {
    return errorResponse(err);
  }
}
