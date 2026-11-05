import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * 實作完成前以靜態空目錄佔位，讓 E2E 案例能執行並因缺少 UI 而紅燈。
 * 實作後改回 `pnpm exec vite --host 127.0.0.1 --port 5173`。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 15_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  use: {
    baseURL: BASE,
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "python3 -m http.server 5173 --bind 127.0.0.1",
    cwd: "./e2e-static",
    url: BASE,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
