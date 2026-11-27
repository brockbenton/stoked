import { defineConfig } from "vitest/config";

const root = new URL(".", import.meta.url).pathname;

// Needs the compiled escrow program, so it isn't part of test:validator.
export default defineConfig({
  resolve: {
    alias: {
      "@/": `${root}`,
      "server-only": `${root}test/server/server-only-stub.ts`,
    },
  },
  test: {
    include: ["test/escrow/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
