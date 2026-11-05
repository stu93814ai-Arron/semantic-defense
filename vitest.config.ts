import { defineConfig } from "vitest/config";
// 核心邏輯覆蓋率清單：之後加 packages/gate、簽名、授權時在此擴充
export const CORE_COVERAGE_INCLUDE = ["packages/contracts/src/**/*.ts"];
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: CORE_COVERAGE_INCLUDE,
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "reports/coverage",
      thresholds: { lines: 70, branches: 70, functions: 70, statements: 70 },
    },
  },
});
