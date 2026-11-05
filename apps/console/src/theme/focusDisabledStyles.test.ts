import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = dirname(fileURLToPath(import.meta.url));
const baseCss = readFileSync(join(dir, "../styles/base.css"), "utf8");
const tokensCss = readFileSync(join(dir, "../styles/tokens.css"), "utf8");
const css = `${tokensCss}\n${baseCss}`;

function extractRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

describe("focus-visible 環（登入／.btn／ThemeSwitch）", () => {
  const targets = [
    ".btn:focus-visible",
    "input:focus-visible",
    ".theme-switch__option:focus-visible",
  ] as const;

  for (const sel of targets) {
    it(`${sel} 有可見 primary outline`, () => {
      const body = extractRule(css, sel);
      expect(body).not.toMatch(/outline:\s*none/);
      expect(body).toMatch(/outline:\s*2px\s+solid\s+var\(--color-primary\)/);
    });
  }

  it("元件規則未以 outline:none 蓋掉 focus", () => {
    for (const sel of [".btn", "input", ".theme-switch__option"] as const) {
      const body = extractRule(baseCss, sel);
      expect(body).not.toMatch(/outline:\s*none/);
    }
  });
});

describe("disabled／忙碌登入按鈕", () => {
  it(".btn:disabled 對齊 surface／muted 與 not-allowed", () => {
    const sel = '.btn:disabled,\n.btn[aria-disabled="true"]';
    const body = extractRule(baseCss, sel);
    expect(body).toMatch(/background:\s*var\(--color-surface(?:-2)?\)/);
    expect(body).toMatch(/color:\s*var\(--color-text-muted\)/);
    expect(body).toMatch(/cursor:\s*not-allowed/);
  });
});
