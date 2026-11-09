import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { phase2ApiPlugin } from "./src/dev/phase2ApiPlugin";

const root = dirname(fileURLToPath(import.meta.url));

/** React JSX 由 esbuild 自動處理；phase2ApiPlugin 提供 E2E／開發用登入面。 */
export default defineConfig({
  plugins: [phase2ApiPlugin()],
  resolve: {
    alias: [
      // 精確比對根入口（勿用字串前綴，否則會吃掉 /ip-cidr.js）
      {
        find: /^@semantic-defense\/contracts$/,
        replacement: resolve(root, "src/shims/contracts-browser.ts"),
      },
      {
        find: "@semantic-defense/contracts/ip-cidr.js",
        replacement: resolve(root, "../../packages/contracts/src/ip-cidr.ts"),
      },
      {
        find: "node:net",
        replacement: resolve(root, "src/shims/node-net.ts"),
      },
    ],
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  esbuild: { jsx: "automatic" },
});
