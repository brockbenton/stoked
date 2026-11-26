import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@stoked/shared", "@stoked/chain"],
  poweredByHeader: false,
  devIndicators: false,
};

export default config;
