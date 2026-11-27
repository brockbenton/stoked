import { handle, json, readJson, tokenOf } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/gifts/submit → verify, co-sign and send the wallet-signed transaction. Safe to repeat. */
export async function POST(req: Request) {
  return handle(async (s) => {
    const r = await s.submit(tokenOf(req), await readJson(req));
    return json(r.body, r.httpStatus);
  });
}
