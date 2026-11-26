import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Load the repo-root .env if present (values are never printed). */
export function loadEnv(): void {
  for (const p of [resolve(process.cwd(), ".env"), resolve(import.meta.dirname, "../../../../.env")]) {
    if (existsSync(p)) {
      process.loadEnvFile(p);
      return;
    }
  }
}
