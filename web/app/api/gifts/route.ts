import { clientKey, handle, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/gifts → {id, claimToken}. The token is returned once; only its hash is stored. */
export async function POST(req: Request) {
  return handle(async (s) => json(await s.create(await readJson(req), clientKey(req))));
}
