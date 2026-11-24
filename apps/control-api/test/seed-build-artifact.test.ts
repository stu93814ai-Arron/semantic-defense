/* eslint-disable security/detect-non-literal-fs-filename -- 測試：路徑來自本套件 tsconfig 與 mkdtemp 產物，非外部輸入 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** 正式 build：只編譯 src/。test 與 test-support 不在 include。 */
function productionConfig(outDir: string): ts.ParsedCommandLine {
  const parsed = ts.parseJsonConfigFileContent(
    {
      extends: "./tsconfig.json",
      compilerOptions: { noEmit: false, outDir, rootDir: "src" },
      include: ["src"],
    },
    ts.sys,
    PKG,
  );
  if (parsed.errors.length > 0) throw new Error("正式 tsconfig 無法解析");
  return parsed;
}

function emitProductionSrc(outDir: string): void {
  const parsed = productionConfig(outDir);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const errors = [...ts.getPreEmitDiagnostics(program), ...program.emit().diagnostics]
    .filter((diag) => diag.category === ts.DiagnosticCategory.Error);
  if (errors.length === 0) return;
  const text = errors.map((diag) => ts.flattenDiagnosticMessageText(diag.messageText, "\n")).join("\n");
  throw new Error(text);
}

describe("正式 build 產物", () => {
  // 軟體大總召裁示（未經使用者確認）：seed-phase2.ts 移出 src，正式 build 不含它。
  // 實作後 it.fails 已改回 it()。
  it("不含 seed-phase2 與測試種子密碼", () => {
    const outDir = mkdtempSync(join(tmpdir(), "sd-prod-"));
    try {
      emitProductionSrc(outDir);
      const files = walk(outDir);
      const blob = files.map((file) => readFileSync(file, "utf8")).join("\n");
      expect(files.some((file) => file.includes("seed"))).toBe(false);
      expect(blob.includes("seedPhase2Fixtures")).toBe(false);
      expect(blob.includes("pass-operator-1")).toBe(false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
