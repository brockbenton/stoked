import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@stoked/shared", "@stoked/chain"],
  // Ships WASM; only loaded for the local database (lib/server/local-db.ts).
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
  devIndicators: false,
};

export default config;
