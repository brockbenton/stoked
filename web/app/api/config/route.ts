import { paymentSettings } from "@/lib/server/env";
import { errorResponse, json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/config → whether senders pay from a wallet, and with what. */
export async function GET() {
  try {
    const p = paymentSettings(process.env);
    return json({ payment: p ? { symbol: p.symbol, mint: p.mint.toBase58() } : null });
  } catch (err) {
    return errorResponse(err);
  }
}
