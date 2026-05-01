import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "web/**"],
    testTimeout: 30_000,
  },
});
