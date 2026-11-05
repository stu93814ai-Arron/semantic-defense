import { defineConfig } from "vitest/config";
// 核心邏輯覆蓋率清單（契約、回放、簽名、授權）。路徑不存在時不計；程式出現即納入 70% 門檻。
// 之後加 packages/gate（回放）、簽名等，在此擴充。
export const CORE_COVERAGE_INCLUDE = [
  "packages/contracts/src/**/*.ts",
  "apps/control-api/src/auth.ts", // 實際佈局：登入、session、cookie、角色型別集中於此檔
  "apps/control-api/src/authz.ts", // PM 核准自 app.ts 拆出集中授權
  "apps/control-api/src/auth/**/*.ts",
  "apps/control-api/src/session/**/*.ts",
  "apps/control-api/src/authz/**/*.ts",
  "apps/control-api/src/roles/**/*.ts",
  // console 邏輯核心（PM 裁示；純 view 的 *.tsx 不納入，見 docs/ci/coverage.md）
  "apps/console/src/api.ts", // API client 錯誤處理（401/404/429）
  "apps/console/src/roles.ts", // 權限／路由閘門（accessFor 等）
  "apps/console/src/theme/theme.ts", // 主題 localStorage＋預設值
  "apps/console/src/review/**/*.ts", // 第 3 階段黑白名單審核決策邏輯（自動納入）
];
// E2E（Playwright）不在 vitest 內跑
const E2E = ["**/e2e/**", "**/*.e2e.*", "**/node_modules/**", "**/dist/**"];
export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      { extends: true, test: { name: "node", environment: "node", exclude: E2E, testTimeout: 60_000, hookTimeout: 60_000, // 與 apps/control-api/vitest.config.ts 一致（Postgres 啟動）
        include: ["packages/*/{src,test}/**/*.test.ts"] } },
      // control-api 測試共用同一個拋棄式 Postgres（DATABASE_URL），檔案間不並行以免互相污染
      { extends: true, test: { name: "control-api", environment: "node", exclude: E2E, testTimeout: 60_000, hookTimeout: 60_000,
        fileParallelism: false, include: ["apps/control-api/{src,test}/**/*.test.ts"] } },
      { extends: true, test: { name: "console", environment: "jsdom", exclude: E2E,
        include: ["apps/console/{src,test}/**/*.test.{ts,tsx}"] } },
    ],
    coverage: {
      provider: "v8",
      include: CORE_COVERAGE_INCLUDE,
      exclude: ["**/*.test.*", "**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "reports/coverage",
      thresholds: { lines: 70, branches: 70, functions: 70, statements: 70 },
    },
  },
});
