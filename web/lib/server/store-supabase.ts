/**
 * GiftStore over Supabase (PostgREST) with the service-role key. Each method
 * is one filtered UPDATE ... RETURNING, so the compare-and-swap semantics
 * match createSqlGiftStore. Server only.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GiftStore, PriceRecord } from "./store";
import { rowToGift } from "./store-sql";

/**
 * `*` rather than a column list: escrow_account is read wherever the column
 * exists, however this server is configured (an escrow gift mistaken for a
 * treasury gift would be paid twice), and a database without the escrow
 * migration keeps working. The aliases keep numeric and bigint as text.
 */
const COLS = "*,token_raw_text:token_raw::text,claim_last_valid_height_text:claim_last_valid_height::text";

const toGift = (r: Record<string, unknown>) =>
  rowToGift({ ...r, token_raw: r.token_raw_text, claim_last_valid_height: r.claim_last_valid_height_text });

export function createSupabaseGiftStore(sb: SupabaseClient): GiftStore {
  const single = async (q: PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    const { data, error } = await q;
    if (error) throw new Error(`database error: ${error.message}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    return rows[0] ? toGift(rows[0]) : null;
  };
  const gifts = () => sb.from("gifts");
  return {
    async insert(g) {
      const r = await single(
        gifts()
          .insert({
            status: "wrapped",
            sender_name: g.senderName,
            recipient_name: g.recipientName,
            ticker: g.ticker,
            usd_cents: g.usdCents,
            price_cents: g.priceCents,
            token_raw: g.tokenRaw,
            note: g.note,
            opens_at: g.opensAt,
            claim_token_hash: g.claimTokenHash,
            created_at: g.createdAt,
            ...(g.escrowAccount ? { id: g.id, escrow_account: g.escrowAccount } : {}),
          })
          .select(COLS),
      );
      if (!r) throw new Error("insert returned no row");
      return r;
    },
    get: (id) => single(gifts().select(COLS).eq("id", id).limit(1)),
    open: (id, at) => single(gifts().update({ status: "opened", opened_at: at }).eq("id", id).eq("status", "wrapped").select(COLS)),
    swap: (id, n) =>
      single(
        gifts()
          .update({ ticker: n.ticker, price_cents: n.priceCents, token_raw: n.tokenRaw })
          .eq("id", id)
          .eq("status", "opened")
          .select(COLS),
      ),
    beginClaim: (id, wallet) =>
      single(gifts().update({ status: "claiming", recipient_wallet: wallet }).eq("id", id).eq("status", "opened").select(COLS)),
    setClaimTx: (id, expected, sig, height) => {
      const q = gifts()
        .update({ claim_signature: sig, claim_last_valid_height: height.toString() })
        .eq("id", id)
        .eq("status", "claiming");
      return single((expected === null ? q.is("claim_signature", null) : q.eq("claim_signature", expected)).select(COLS));
    },
    markClaimed: (id, sig, at) =>
      single(
        gifts()
          .update({ status: "claimed", claimed_at: at })
          .eq("id", id)
          .eq("status", "claiming")
          .eq("claim_signature", sig)
          .select(COLS),
      ),
    async countCreatedSince(since) {
      const { count, error } = await gifts().select("id", { count: "exact", head: true }).gte("created_at", since);
      if (error) throw new Error(`database error: ${error.message}`);
      return count ?? 0;
    },
    async getPrice(ticker): Promise<PriceRecord | null> {
      const { data, error } = await sb.from("prices").select("usd_cents,source,updated_at").eq("ticker", ticker).limit(1);
      if (error) throw new Error(`database error: ${error.message}`);
      const r = data?.[0] as { usd_cents: number; source: string; updated_at: string } | undefined;
      return r ? { usdCents: r.usd_cents, source: r.source, updatedAt: new Date(r.updated_at).toISOString() } : null;
    },
  };
}
