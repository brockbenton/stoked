/**
 * In-process Postgres (PGlite) with the real migrations, for running the app
 * against a local validator without any accounts. Data is lost on restart.
 * Enabled only by STOKED_LOCAL_DB=1; env.ts refuses it anywhere but local.
 */
import type { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlClient } from "./store-sql";

// On globalThis so every route bundle in the server process shares one database.
const shared = globalThis as typeof globalThis & { stokedLocalDb?: Promise<PGlite> };

async function create(): Promise<PGlite> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create();
  // `next start` and `next dev` run from web/.
  const dir = join(/* turbopackIgnore: true */ process.cwd(), "..", "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  return db;
}

export function localDbClient(): SqlClient {
  return {
    async query<T>(text: string, params?: unknown[]) {
      shared.stokedLocalDb ??= create();
      return (await shared.stokedLocalDb).query<T>(text, params);
    },
  };
}
