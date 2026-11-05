import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tokensCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles/tokens.css"),
  "utf8",
);

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "").toLowerCase();
  expect(h).toMatch(/^[0-9a-f]{6}$/);
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

function channelLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(channelLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio of two sRGB hex colours. */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(parseHex(fg));
  const b = relativeLuminance(parseHex(bg));
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function themeBlock(theme: "nordic" | "italian"): string {
  if (theme === "nordic") {
    const start = tokensCss.indexOf('[data-theme="nordic"]');
    const end = tokensCss.indexOf('[data-theme="italian"]');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return tokensCss.slice(start, end);
  }
  const start = tokensCss.indexOf('[data-theme="italian"]');
  const end = tokensCss.indexOf(":root {", start);
  expect(start).toBeGreaterThanOrEqual(0);
  return tokensCss.slice(start, end > start ? end : undefined);
}

function tokenHex(block: string, name: string): string {
  const needle = `${name}:`;
  const i = block.indexOf(needle);
  expect(i, `missing ${name}`).toBeGreaterThanOrEqual(0);
  const after = block.slice(i + needle.length);
  const m = after.match(/^\s*(#[0-9A-Fa-f]{6})\b/);
  expect(m, `hex for ${name}`).toBeTruthy();
  return (m?.[1] ?? "").toLowerCase();
}

const PAIRS: { fg: string; bg: string; label: string }[] = [
  { fg: "--color-text", bg: "--color-bg", label: "text on bg" },
  { fg: "--color-text", bg: "--color-surface", label: "text on surface" },
  { fg: "--color-text-muted", bg: "--color-bg", label: "muted on bg" },
  { fg: "--color-text-muted", bg: "--color-surface", label: "muted on surface" },
  {
    fg: "--color-on-primary",
    bg: "--color-primary",
    label: "on-primary on primary",
  },
  {
    fg: "--color-on-wood",
    bg: "--color-wood-from",
    label: "on-wood on wood-from",
  },
  { fg: "--color-on-wood", bg: "--color-wood-to", label: "on-wood on wood-to" },
];

describe("tokens.css WCAG AA 對比（≥4.5:1）", () => {
  for (const theme of ["nordic", "italian"] as const) {
    describe(theme, () => {
      const block = themeBlock(theme);
      for (const pair of PAIRS) {
        it(`${pair.label}`, () => {
          const ratio = contrastRatio(
            tokenHex(block, pair.fg),
            tokenHex(block, pair.bg),
          );
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }
});
