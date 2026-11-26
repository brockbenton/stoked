import { defineConfig } from "vitest/config";

const root = new URL(".", import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      "@/": `${root}`,
      "server-only": `${root}test/server/server-only-stub.ts`,
    },
  },
  test: { include: ["test/**/*.test.ts"], exclude: ["test/validator/**", "**/node_modules/**"] },
});
