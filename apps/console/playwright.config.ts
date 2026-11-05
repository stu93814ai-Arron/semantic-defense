import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;
const BASE = `http://127.0.0.1:${PORT}`;

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
    command: "pnpm exec vite --host 127.0.0.1 --port 5173",
    url: BASE,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      VITE_IDLE_TIMEOUT_MS: "50",
    },
  },
});
