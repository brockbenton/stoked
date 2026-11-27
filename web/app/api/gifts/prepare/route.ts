import { clientKey, handle, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/gifts/prepare → a priced gift and the unsigned transaction for the sender's wallet. */
export async function POST(req: Request) {
  return handle(async (s) => json(await s.prepare(await readJson(req), clientKey(req))));
}
