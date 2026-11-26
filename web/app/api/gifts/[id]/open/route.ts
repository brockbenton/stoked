import { handle, json, tokenOf } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/gifts/:id/open (Bearer token): wrapped → opened; 425 too_early before opensAt. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async (s) => json(await s.open(id, tokenOf(req))));
}
