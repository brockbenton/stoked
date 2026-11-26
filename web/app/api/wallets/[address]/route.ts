import { clientKey, handleWallet, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/wallets/:address → devnet test token balances. Public chain data; no auth. */
export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  return handleWallet(async (s) => json(await s.holdings(address, clientKey(req))));
}
