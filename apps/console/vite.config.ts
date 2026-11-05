import { defineConfig } from "vite";

/** React JSX 由 esbuild 自動處理；E2E／開發用登入面於下一個 commit 掛上。 */
export default defineConfig({
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  esbuild: { jsx: "automatic" },
});
