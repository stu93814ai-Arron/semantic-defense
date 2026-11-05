import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const baseCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles/base.css"),
  "utf8",
);

const OPTION = ".theme-switch__option";
const OPTION_HOVER = ".theme-switch__option:hover";
const SELECTED = '.theme-switch__option[data-selected="true"]';
const SELECTED_HOVER = '.theme-switch__option[data-selected="true"]:hover';

function extractRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

describe("ThemeSwitch 樣式細修", () => {
  it("選項高度為 36px", () => {
    expect(extractRule(baseCss, OPTION)).toMatch(/height:\s*36px/);
  });

  it("切換器與選項 radius 跟 --radius-control", () => {
    expect(extractRule(baseCss, ".theme-switch")).toMatch(
      /border-radius:\s*var\(--radius-control\)/,
    );
    expect(extractRule(baseCss, OPTION)).toMatch(
      /border-radius:\s*var\(--radius-control\)/,
    );
  });

  it("未選中 hover 有底線（非只靠顏色）", () => {
    const body = extractRule(baseCss, OPTION_HOVER);
    expect(body).toMatch(/text-decoration:\s*underline|box-shadow:/);
  });

  it("選中 hover 維持底線或 ✓ 非只靠顏色", () => {
    expect(extractRule(baseCss, SELECTED)).toMatch(/box-shadow:/);
    const hover = extractRule(baseCss, SELECTED_HOVER);
    expect(hover).toMatch(/box-shadow:|text-decoration:\s*underline/);
  });
});
