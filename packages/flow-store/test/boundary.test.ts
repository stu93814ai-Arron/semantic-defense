/* eslint-disable security/detect-non-literal-fs-filename -- 測試：路徑來自本倉庫目錄走訪與固定常數，非外部輸入 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * flow-store 邊界（總召 2026-11-09 17:35 裁示；不引入 dependency-cruiser／eslint-plugin-boundaries 等新套件，改以 vitest 掃 import）：
 * 1. 兩個入口：./write（DDL、insertFlow 等寫入，只給 sensor-ingest）與 ./read（唯讀，給 control-api 判定 tick）；無根入口。
 * 2. control-api（src 與 test）不得 import 寫入入口：涵蓋 import／export from／side-effect import／require()／動態 import()。
 * 3. 唯讀入口不得（直接或間接）引入 write.ts。
 * 4. flow_events／flow_rejections 的 DDL（CREATE TABLE／INDEX）只在 packages/flow-store/src/write.ts 一處。
 * 5. flow-store 不依賴任何 app。
 */
const PKG = resolve(__dirname, "..");
const REPO = resolve(PKG, "../..");
const SKIP = new Set(["node_modules", "dist", "coverage", "reports", ".git", "playwright-report", "test-results"]);
const walk = (d: string): string[] => existsSync(d)
  ? readdirSync(d, { withFileTypes: true }).filter((e) => !SKIP.has(e.name))
    .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
  : [];
const isCode = (f: string) => /\.(m|c)?[jt]sx?$/.test(f);

/** 取出所有模組指定字串：static import／export from、side-effect import、require()、動態 import()（含換行空白）。 */
const SPEC = /(?:import|export)\s[^'"`;]*?from\s*['"`]([^'"`]+)['"`]|import\s*['"`]([^'"`]+)['"`]|(?:require|import)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
export const specifiers = (src: string): string[] => [...src.matchAll(SPEC)].map((m) => (m[1] ?? m[2] ?? m[3])!);

/** spec 是否指到寫入入口（套件路徑或相對／絕對路徑進 flow-store/src 但不是 read）。 */
function hitsWriteEntry(spec: string, fromFile: string): boolean {
  if (spec.startsWith("@semantic-defense/flow-store")) return spec !== "@semantic-defense/flow-store/read";
  if (!spec.startsWith(".") && !spec.startsWith("/")) return false;
  const abs = spec.startsWith("/") ? spec : resolve(dirname(fromFile), spec);
  const rel = relative(join(PKG, "src"), abs);
  if (rel.startsWith("..")) return relative(PKG, abs) === ""; // 指到套件根目錄也算
  return !/^read(\.[jt]s)?$/.test(rel);
}

describe("flow-store 入口與邊界", () => {
  it("package.json exports 恰為 ./write 與 ./read，且檔案存在", () => {
    const pj = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { exports?: Record<string, string> };
    expect(pj.exports).toEqual({ "./write": "./src/write.ts", "./read": "./src/read.ts" });
    for (const f of Object.values(pj.exports!)) expect(existsSync(join(PKG, f)), f).toBe(true);
  });

  it("掃描器涵蓋各種 import 形式（夾具）", () => {
    const src = [
      'import { insertFlow } from "@semantic-defense/flow-store/write";',
      'export { x } from "@semantic-defense/flow-store/write";',
      'import "@semantic-defense/flow-store/write";',
      'const a = require("@semantic-defense/flow-store/write");',
      'const b = await import(\n  "@semantic-defense/flow-store/write"\n);',
      "const c = await import(`@semantic-defense/flow-store/write`);",
      'import type { FlowDb } from "@semantic-defense/flow-store/read";',
    ].join("\n");
    const specs = specifiers(src);
    expect(specs).toHaveLength(7);
    expect(specs.filter((s) => hitsWriteEntry(s, join(REPO, "apps/control-api/src/x.ts")))).toHaveLength(6);
    const viaPath = join(REPO, "apps/control-api/src/x.ts");
    expect(hitsWriteEntry("../../../packages/flow-store/src/write.js", viaPath)).toBe(true);
    expect(hitsWriteEntry("../../../packages/flow-store", viaPath)).toBe(true);
    expect(hitsWriteEntry("../../../packages/flow-store/src/read.js", viaPath)).toBe(false);
    expect(hitsWriteEntry("@semantic-defense/flow-store", viaPath)).toBe(true);
  });

  it("control-api（src＋test）不 import 寫入入口", () => {
    const files = walk(join(REPO, "apps/control-api")).filter(isCode);
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap((f) => specifiers(readFileSync(f, "utf8"))
      .filter((s) => hitsWriteEntry(s, f)).map((s) => `${relative(REPO, f)}: ${s}`));
    expect(bad).toEqual([]);
  });

  it("唯讀入口不（直接或間接）引入 write.ts", () => {
    const seen = new Set<string>();
    const visit = (f: string): void => {
      if (seen.has(f)) return;
      seen.add(f);
      for (const s of specifiers(readFileSync(f, "utf8")).filter((x) => x.startsWith("."))) {
        visit(resolve(dirname(f), s).replace(/\.js$/, ".ts"));
      }
    };
    visit(join(PKG, "src/read.ts"));
    expect([...seen].map((f) => relative(PKG, f))).not.toContain("src/write.ts");
  });

  it("flow_events／flow_rejections 的 DDL 只在 packages/flow-store/src/write.ts", () => {
    const CREATE = /CREATE\s+(?:UNIQUE|TABLE|INDEX)\b/gi;
    const TABLE = /\bflow_(?:events|rejections)\b/;
    // 每個 CREATE TABLE／INDEX 取到語句結尾（; 或字串引號）為止，看是否指涉兩張表
    const hasDdl = (src: string) => [...src.matchAll(CREATE)].some((m) => TABLE.test(src.slice(m.index, m.index + 400).split(/[;`"]/)[0]!));
    const hits = [...walk(join(REPO, "apps")), ...walk(join(REPO, "packages")), ...walk(join(REPO, "scripts"))]
      .filter((f) => isCode(f) || f.endsWith(".sql"))
      .filter((f) => !f.endsWith("boundary.test.ts") && hasDdl(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f));
    expect(hits).toEqual(["packages/flow-store/src/write.ts"]);
  });

  it("flow-store src 與 package.json 不指涉任何 app", () => {
    const APP_REF = /@semantic-defense\/(control-api|console|sensor-ingest)|apps\/(control-api|console|sensor-ingest)/;
    const src = walk(join(PKG, "src")).filter(isCode);
    expect(src.length).toBeGreaterThan(0);
    expect([...src, join(PKG, "package.json")].filter((f) => APP_REF.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
