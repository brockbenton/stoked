import { defineConfig } from "vitest/config";

// Needs the compiled escrow program, so it isn't part of test:validator.
export default defineConfig({
  test: {
    include: ["escrow/test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
