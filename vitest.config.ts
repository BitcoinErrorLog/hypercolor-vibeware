import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
    exclude: ["**/._*", "**/node_modules/**"],
  },
});
