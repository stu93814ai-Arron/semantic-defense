import { defineConfig } from "vite";
import { phase2ApiPlugin } from "./src/dev/phase2ApiPlugin";

/** React JSX 由 esbuild 自動處理；phase2ApiPlugin 提供 E2E／開發用登入面。 */
export default defineConfig({
  plugins: [phase2ApiPlugin()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  esbuild: { jsx: "automatic" },
});
