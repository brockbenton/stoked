import { handle, json, readJson, tokenOf } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/gifts/:id/swap (Bearer token) {ticker}: only while opened; same USD value. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async (s) => json(await s.swap(id, tokenOf(req), await readJson(req))));
}
