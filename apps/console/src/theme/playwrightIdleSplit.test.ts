import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IDLE_E2E_GREP } from "../../playwright.config";

const configText = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../playwright.config.ts"),
  "utf8",
);

describe("E2E 短 idle 僅限閒置規格", () => {
  it("IDLE_E2E_GREP 對準驗收測試師閒置案例標題", () => {
    expect("閒置逾時後進入受保護頁會回到登入").toMatch(IDLE_E2E_GREP);
    expect("登入後 document.cookie 不含 sd_session").not.toMatch(IDLE_E2E_GREP);
  });

  it("chromium-idle 才設 VITE_IDLE_TIMEOUT_MS=50；一般專案清除該變數", () => {
    expect(configText).toMatch(/name:\s*"chromium-idle"/);
    expect(configText).toMatch(/grep:\s*IDLE_E2E_GREP/);
    expect(configText).toMatch(/grepInvert:\s*IDLE_E2E_GREP/);
    expect(configText).toMatch(/VITE_IDLE_TIMEOUT_MS\s*=\s*"50"/);
    expect(configText).toMatch(/delete env\.VITE_IDLE_TIMEOUT_MS/);
    // 不得再全域硬編短 idle 到單一 webServer
    expect(configText).not.toMatch(
      /webServer:\s*\{[^}]*VITE_IDLE_TIMEOUT_MS:\s*"50"/s,
    );
  });
});

describe("E2E 連接埠由環境變數決定（每個 webServer 各一個）", () => {
  it("兩個 webServer 分別讀 E2E_PORT、E2E_IDLE_PORT，並使用 strictPort", () => {
    expect(configText).toMatch(/portFromEnv\("E2E_PORT", 5173\)/);
    expect(configText).toMatch(/portFromEnv\("E2E_IDLE_PORT", 5174\)/);
    expect(configText).toMatch(/--port \$\{NORMAL_PORT\} --strictPort/);
    expect(configText).toMatch(/--port \$\{IDLE_PORT\} --strictPort/);
  });
});
