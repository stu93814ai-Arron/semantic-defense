import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  initTheme,
  parseTheme,
  readStoredTheme,
} from "./theme";

const tokensPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../styles/tokens.css",
);

describe("theme (§8 驗收 1／3／6 tokens)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    vi.unstubAllGlobals();
  });

  it("1. 無 sd.theme 時預設 nordic", () => {
    expect(THEME_STORAGE_KEY).toBe("sd.theme");
    expect(DEFAULT_THEME).toBe("nordic");
    expect(parseTheme(null)).toBe("nordic");
    expect(initTheme()).toBe("nordic");
    expect(document.documentElement.getAttribute("data-theme")).toBe("nordic");
  });

  it("2. applyTheme italian 寫入 sd.theme", () => {
    applyTheme("italian");
    expect(localStorage.getItem("sd.theme")).toBe("italian");
    expect(document.documentElement.dataset.theme).toBe("italian");
  });

  it("3. 亂值或 localStorage 不可用時回 nordic、不報錯", () => {
    localStorage.setItem("sd.theme", "neon-chaos");
    expect(readStoredTheme()).toBe("nordic");
    expect(initTheme()).toBe("nordic");

    const boom = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    vi.stubGlobal("localStorage", boom);
    expect(() => readStoredTheme()).not.toThrow();
    expect(readStoredTheme()).toBe("nordic");
    expect(() => applyTheme("italian")).not.toThrow();
  });

  it("6. tokens.css 兩主題主色與設計規範一致（對比表來源色）", () => {
    const text = readFileSync(tokensPath, "utf8");
    expect(text).toMatch(/--color-primary:\s*#4f6b57/i);
    expect(text).toMatch(/\[data-theme="italian"\][\s\S]*--color-primary:\s*#a4472c/i);
    expect(text).toMatch(/--color-wood-from/);
    expect(text).toMatch(/--color-text:\s*#2e2a24/i);
    expect(text).toMatch(/\[data-theme="italian"\][\s\S]*--color-text:\s*#1e1c1a/i);
  });
});
