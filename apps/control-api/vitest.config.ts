import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 共用 DATABASE_URL：檔案並行會互相 TRUNCATE／污染速率計數
    fileParallelism: false,
  },
});
