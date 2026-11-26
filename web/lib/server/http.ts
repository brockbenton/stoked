import "server-only";
import { ApiError } from "./errors";
import { getService } from "./env";
import type { GiftService } from "./service";
import { bearerToken } from "./tokens";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

interface ZodLikeError {
  name: "ZodError";
  issues: { path: PropertyKey[]; message: string }[];
}

function isZodError(err: unknown): err is ZodLikeError {
  return err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues);
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return json({ error: { code: err.code, message: err.message } }, err.status);
  if (isZodError(err)) {
    const message = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return json({ error: { code: "validation_failed", message: message || "Invalid request" } }, 400);
  }
  // Never echo internals (could include keys or connection strings).
  console.error("api error:", err instanceof Error ? err.name : typeof err);
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

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "unknown";
}

/** Run a handler against the service, mapping errors to `{ error: { code, message } }`. */
export async function handle(fn: (service: GiftService) => Promise<Response>): Promise<Response> {
  try {
    return await fn(getService());
  } catch (err) {
    return errorResponse(err);
  }
}
