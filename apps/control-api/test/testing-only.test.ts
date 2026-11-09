/* eslint-disable security/detect-non-literal-fs-filename -- 測試：路徑來自本套件 src 目錄走訪，非外部輸入 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * R17（資安，low）：writeAutoBlocklistEntry（自己開 tx、不帶 gates 的 §7 包裝）只給測試用，
 * 搬到 test/helpers/auto-list.ts；產品碼（src）不得定義或引用它，也不得 import test/ 底下任何東西。
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const srcFiles = () => readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((f) => /\.[cm]?tsx?$/.test(f)).map((f) => [f, readFileSync(join(SRC, f), "utf8")] as const);

describe("R17：測試專用的上榜包裝不在產品碼", () => {
  it("src 沒有任何檔案提到 writeAutoBlocklistEntry", () => {
    expect(srcFiles().filter(([, s]) => s.includes("writeAutoBlocklistEntry")).map(([f]) => f)).toEqual([]);
  });

  it("src 不 import test/（含 helpers）", () => {
    const IMPORTS_TEST = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*\/test\//;
    expect(srcFiles().filter(([, s]) => IMPORTS_TEST.test(s)).map(([f]) => f)).toEqual([]);
  });
});
