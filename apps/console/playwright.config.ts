import { defineConfig, devices } from "@playwright/test";

/** 每個 webServer 各用一個連接埠；scripts/e2e.sh 會挑兩個空閒埠透過環境變數傳入，未設定時才用預設值。 */
function portFromEnv(name: "E2E_PORT" | "E2E_IDLE_PORT", fallback: number): number {
  const raw = name === "E2E_PORT" ? process.env.E2E_PORT : process.env.E2E_IDLE_PORT;
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} 必須是 1–65535 的整數：${raw}`);
  return n;
}
const NORMAL_PORT = portFromEnv("E2E_PORT", 5173);
const IDLE_PORT = portFromEnv("E2E_IDLE_PORT", 5174);
if (NORMAL_PORT === IDLE_PORT) throw new Error("E2E_PORT 與 E2E_IDLE_PORT 不可相同");
const NORMAL_BASE = `http://127.0.0.1:${NORMAL_PORT}`;
const IDLE_BASE = `http://127.0.0.1:${IDLE_PORT}`;

/** 閒置逾時 E2E 的測試標題（驗收測試師原文）；僅此測跑短 idle 伺服器。 */
export const IDLE_E2E_GREP = /閒置逾時後進入受保護頁會回到登入/;

function viteEnv(shortIdle: boolean): { [key: string]: string } {
  const env: { [key: string]: string } = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  delete env.VITE_IDLE_TIMEOUT_MS;
  if (shortIdle) env.VITE_IDLE_TIMEOUT_MS = "50";
  // e2e 只有登入面 plugin，無管理 API：明確開 demo 回退
  env.VITE_DEMO_FALLBACK = "1";
  return env;
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 15_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  projects: [
    {
      name: "chromium",
      grepInvert: IDLE_E2E_GREP,
      use: { ...devices["Desktop Chrome"], baseURL: NORMAL_BASE, trace: "off" },
    },
    {
      name: "chromium-idle",
      grep: IDLE_E2E_GREP,
      use: { ...devices["Desktop Chrome"], baseURL: IDLE_BASE, trace: "off" },
    },
  ],
  webServer: [
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${NORMAL_PORT} --strictPort`,
      url: NORMAL_BASE,
      reuseExistingServer: false,
      timeout: 30_000,
      env: viteEnv(false),
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${IDLE_PORT} --strictPort`,
      url: IDLE_BASE,
      reuseExistingServer: false,
      timeout: 30_000,
      env: viteEnv(true),
    },
  ],
});
