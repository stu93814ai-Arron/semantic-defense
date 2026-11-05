import { defineConfig } from "vitest/config";

/** 僅供 docs/demo 手動演示啟動；不納入倉庫根 vitest projects。 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["docs/demo/start-server.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
