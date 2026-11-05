import { defineConfig } from "vite";

/** 第 2 階段實作前僅佔位；E2E 預期由此啟動。 */
export default defineConfig({
  server: { port: 5173, strictPort: true },
});
