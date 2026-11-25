import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "..", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let db: PGlite;

async function insertGift(overrides: Record<string, unknown> = {}) {
  const row = {
    kind: "single",
    status: "wrapped",
    sender_name: "Alex",
    recipient_name: "Maya",
    ticker: "NVDA",
    usd_cents: 1000,
    claim_token_hash: "a".repeat(64),
    ...overrides,
  };
  const cols = Object.keys(row);
  const res = await db.query<{ id: string }>(
    `insert into gifts (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  db = await PGlite.create();
  for (const f of files) await db.exec(readFileSync(join(dir, f), "utf8"));
});

afterAll(async () => {
  await db.close();
});

describe("migrations applied in PGlite", () => {
  it("finds the migration files", () => {
    expect(files).toContain("20261125000000_init.sql");
  });

  it("creates the planned tables", async () => {
    const res = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(res.rows.map((r) => r.table_name)).toEqual(["contributions", "gifts", "prices"]);
  });

  it("enables RLS on every table with no policies", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "contributions", relrowsecurity: true },
      { relname: "gifts", relrowsecurity: true },
      { relname: "prices", relrowsecurity: true },
    ]);
    const policies = await db.query("select * from pg_policies where schemaname = 'public'");
    expect(policies.rows).toHaveLength(0);
  });

  it("an anonymous role sees no rows and cannot write", async () => {
    await insertGift();
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      end $$;
      grant usage on schema public to anon;
      grant select, insert, update, delete on all tables in schema public to anon;
    `);
    await db.exec("set role anon");
    try {
      const res = await db.query("select * from gifts");
      expect(res.rows).toHaveLength(0);
      await expect(db.query("insert into prices (ticker, usd_cents, source) values ('NVDA', 1, 'x')")).rejects.toThrow(
        /row-level security/,
      );
    } finally {
      await db.exec("reset role");
    }
    const owner = await db.query("select * from gifts");
    expect(owner.rows.length).toBeGreaterThan(0);
  });

  it("generates ids and timestamps and stores raw units without loss", async () => {
    const raw = "123456789012345678901234567890123456789"; // 39 digits
    const id = await insertGift({ status: "opened", price_cents: 22952, token_raw: raw });
    const res = await db.query<{ id: string; token_raw: string; created_at: Date }>(
      "select id, token_raw::text as token_raw, created_at from gifts where id = $1",
      [id],
    );
    expect(res.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.rows[0]!.token_raw).toBe(raw);
    expect(res.rows[0]!.created_at).toBeInstanceOf(Date);
  });

  it("enforces kind, status and positive amounts", async () => {
    await expect(insertGift({ kind: "pair" })).rejects.toThrow(/check constraint/);
    await expect(insertGift({ status: "expired" })).rejects.toThrow(/check constraint/);
    await expect(insertGift({ usd_cents: 0 })).rejects.toThrow(/check constraint/);
    await expect(insertGift({ claim_token_hash: null })).rejects.toThrow(/not-null/);
  });

  it("contributions are unique per gift and idempotency key, and reference a gift", async () => {
    const giftId = await insertGift({ kind: "group", status: "funding", usd_cents: 7500 });
    const key = "5d3c3a0e-6b8e-4c43-9a51-2f7f1c1f7b10";
    const insert = (gift: string, k: string) =>
      db.query("insert into contributions (gift_id, idempotency_key, contributor_name, usd_cents) values ($1, $2, 'Sam', 2500)", [
        gift,
        k,
      ]);
    await insert(giftId, key);
    await expect(insert(giftId, key)).rejects.toThrow(/unique/);
    await expect(insert("00000000-0000-4000-8000-000000000000", key)).rejects.toThrow(/foreign key/);
  });

  it("prices are keyed by ticker", async () => {
    await db.query("insert into prices (ticker, usd_cents, source) values ('NVDA', 22952, 'demo')");
    await expect(db.query("insert into prices (ticker, usd_cents, source) values ('NVDA', 1, 'demo')")).rejects.toThrow(
      /duplicate key/,
    );
  });
});
