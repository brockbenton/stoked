/**
 * GiftStore over plain SQL. Tests run it on PGlite with the real migration;
 * it works with any client exposing `query(text, params) → { rows }`.
 */
import type { Ticker } from "@stoked/shared";
import type { GiftRecord, GiftStore, NewGift, PriceRecord } from "./store";

export interface SqlClient {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());

export function rowToGift(r: Row): GiftRecord {
  return {
    id: String(r.id),
    status: r.status as GiftRecord["status"],
    senderName: String(r.sender_name),
    recipientName: String(r.recipient_name),
    ticker: r.ticker as Ticker,
    usdCents: Number(r.usd_cents),
    priceCents: Number(r.price_cents),
    tokenRaw: String(r.token_raw),
    note: (r.note as string | null) ?? null,
    opensAt: iso(r.opens_at),
    claimTokenHash: String(r.claim_token_hash),
    recipientWallet: (r.recipient_wallet as string | null) ?? null,
    claimSignature: (r.claim_signature as string | null) ?? null,
    claimLastValidHeight: r.claim_last_valid_height == null ? null : BigInt(String(r.claim_last_valid_height)),
    createdAt: iso(r.created_at)!,
    openedAt: iso(r.opened_at),
    claimedAt: iso(r.claimed_at),
    escrowAccount: (r.escrow_account as string | null) ?? null,
  };
}

// numeric/bigint as text so no driver turns them into lossy JS numbers.
const COLS = `id, status, sender_name, recipient_name, ticker, usd_cents, price_cents, token_raw::text as token_raw,
  note, opens_at, claim_token_hash, recipient_wallet, claim_signature,
  claim_last_valid_height::text as claim_last_valid_height, created_at, opened_at, claimed_at, escrow_account`;

export function createSqlGiftStore(db: SqlClient): GiftStore {
  const one = async (text: string, params: unknown[]) => {
    const { rows } = await db.query<Row>(text, params);
    return rows[0] ? rowToGift(rows[0]) : null;
  };
  return {
    async insert(g: NewGift) {
      const r = await one(
        `insert into gifts (status, sender_name, recipient_name, ticker, usd_cents, price_cents, token_raw, note, opens_at, claim_token_hash, created_at, id, escrow_account)
         values ('wrapped', $1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, coalesce($11::uuid, gen_random_uuid()), $12) returning ${COLS}`,
        [g.senderName, g.recipientName, g.ticker, g.usdCents, g.priceCents, g.tokenRaw, g.note, g.opensAt, g.claimTokenHash, g.createdAt, g.id ?? null, g.escrowAccount ?? null],
      );
      if (!r) throw new Error("insert returned no row");
      return r;
    },
    get: (id) => one(`select ${COLS} from gifts where id = $1`, [id]),
    open: (id, at) =>
      one(`update gifts set status = 'opened', opened_at = $2 where id = $1 and status = 'wrapped' returning ${COLS}`, [id, at]),
    swap: (id, n) =>
      one(
        `update gifts set ticker = $2, price_cents = $3, token_raw = $4::numeric
         where id = $1 and status = 'opened' returning ${COLS}`,
        [id, n.ticker, n.priceCents, n.tokenRaw],
      ),
    beginClaim: (id, wallet) =>
      one(
        `update gifts set status = 'claiming', recipient_wallet = $2
         where id = $1 and status = 'opened' returning ${COLS}`,
        [id, wallet],
      ),
    setClaimTx: (id, expected, sig, height) =>
      one(
        `update gifts set claim_signature = $3, claim_last_valid_height = $4::bigint
         where id = $1 and status = 'claiming' and claim_signature is not distinct from $2 returning ${COLS}`,
        [id, expected, sig, height.toString()],
      ),
    markClaimed: (id, sig, at) =>
      one(
        `update gifts set status = 'claimed', claimed_at = $3
         where id = $1 and status = 'claiming' and claim_signature = $2 returning ${COLS}`,
        [id, sig, at],
      ),
    async countCreatedSince(since) {
      const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from gifts where created_at >= $1`, [since]);
      return Number(rows[0]?.n ?? 0);
    },
    async getPrice(ticker): Promise<PriceRecord | null> {
      const { rows } = await db.query<Row>(`select usd_cents, source, updated_at from prices where ticker = $1`, [ticker]);
      const r = rows[0];
      return r ? { usdCents: Number(r.usd_cents), source: String(r.source), updatedAt: iso(r.updated_at)! } : null;
    },
  };
}
