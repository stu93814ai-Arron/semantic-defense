/* eslint-disable security/detect-non-literal-fs-filename -- 測試：路徑來自本套件 src 的相對 import 走訪，非外部輸入 */
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as main from "@semantic-defense/contracts";
import * as browser from "@semantic-defense/contracts/browser";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const pkg = JSON.parse(readFileSync(resolve(SRC, "../package.json"), "utf8")) as { exports: Record<string, string> };
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, m.split("/")[0]!]));

/** 從入口遞迴走訪相對 import（含 export … from、動態 import），回傳 {檔案, 外部 specifier} 清單。 */
function moduleGraph(entry: string): { files: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
    for (const m of code.matchAll(re)) {
      const spec = (m[1] ?? m[2] ?? m[3])!;
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      else external.add(spec);
    }
  };
  visit(entry);
  return { files: [...seen], external: [...external] };
}

describe("contracts ./browser 入口（瀏覽器安全）", () => {
  it("package.json exports 有 ./browser", () => {
    expect(pkg.exports["./browser"]).toBe("./src/browser.ts");
  });

  it("模組圖不含任何 node: 匯入，也不含無前綴的 node 內建（crypto、net…）", () => {
    const { files, external } = moduleGraph(resolve(SRC, "../", pkg.exports["./browser"]!));
    expect(files.length).toBeGreaterThan(1);
    expect(external.filter((s) => s.startsWith("node:") || BUILTIN.has(s.split("/")[0]!))).toEqual([]);
  });

  it("轉出的 API 與主入口是同一個實作", () => {
    expect(Object.keys(browser).sort()).toEqual(["assertAllowlistCidr", "assertIpOrCidr", "isHostPrefix", "parseCidr"]);
    expect(browser.assertAllowlistCidr).toBe(main.assertAllowlistCidr);
    expect(browser.assertIpOrCidr).toBe(main.assertIpOrCidr);
    expect(browser.isHostPrefix).toBe(main.isHostPrefix);
    expect(browser.parseCidr).toBe(main.parseCidr);
  });

  it.each([
    ["10.0.0.0/8", true], ["10.0.0.1", true], ["10.0.0.1/32", true], ["2001:db8::/32", true], ["2001:db8::1/128", true],
    ["2001:DB8::/32", false], ["2001:0db8::/32", false], ["::ffff:10.0.0.1", false], ["::ffff:a00:1", false],
    ["127.0.0.1", false], ["169.254.0.0/16", false], ["fe80::/64", false], ["::1", false], ["10.0.0.1/8", false],
    ["0.0.0.0/0", false], ["10.0.0.0/024", false], ["fe80::1%eth0", false], ["01.2.3.4", false],
  ] as const)("browser 入口 assertAllowlistCidr(%j) → %s", (raw, ok) => {
    expect(browser.assertAllowlistCidr(raw)).toBe(ok);
  });
});

