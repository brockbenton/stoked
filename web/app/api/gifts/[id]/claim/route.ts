import { handle, json, readJson, tokenOf } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/gifts/:id/claim (Bearer token) {wallet}: 200 claimed, 202 pending. Safe to retry. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async (s) => {
    const { httpStatus, body } = await s.claim(id, tokenOf(req), await readJson(req));
    return json(body, httpStatus);
  });
}
