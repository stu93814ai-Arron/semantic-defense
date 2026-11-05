import { defineConfig } from "vitest/config";
// 核心邏輯覆蓋率清單（契約、回放、簽名、授權）。路徑不存在時不計；程式出現即納入 70% 門檻。
// 之後加 packages/gate（回放）、簽名等，在此擴充。
export const CORE_COVERAGE_INCLUDE = [
  "packages/contracts/src/**/*.ts",
  "apps/control-api/src/auth/**/*.ts",
  "apps/control-api/src/session/**/*.ts",
  "apps/control-api/src/authz/**/*.ts",
  "apps/control-api/src/roles/**/*.ts",
];
// E2E（Playwright）不在 vitest 內跑
const E2E = ["**/e2e/**", "**/*.e2e.*", "**/node_modules/**", "**/dist/**"];
export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      { extends: true, test: { name: "node", environment: "node", exclude: E2E,
        include: ["packages/*/{src,test}/**/*.test.ts", "apps/control-api/{src,test}/**/*.test.ts"] } },
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
