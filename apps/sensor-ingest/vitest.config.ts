import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 共用 DATABASE_URL 與 sensor_ingest_test schema：檔案並行會競態建表／互相清表
    fileParallelism: false,
  },
});
