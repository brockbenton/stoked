import { handle, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/gifts/:id → public state. A wrapped gift has no ticker, amount or note. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handle(async (s) => json(await s.get(id)));
}
