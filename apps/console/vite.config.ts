import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { phase2ApiPlugin } from "./src/dev/phase2ApiPlugin";

const root = dirname(fileURLToPath(import.meta.url));

/** React JSX 由 esbuild 自動處理；phase2ApiPlugin 提供 E2E／開發用登入面。 */
export default defineConfig({
  plugins: [phase2ApiPlugin()],
  resolve: {
    alias: {
      "@semantic-defense/contracts/ip-cidr.js": resolve(
        root,
        "../../packages/contracts/src/ip-cidr.ts",
      ),
      "node:net": resolve(root, "src/shims/node-net.ts"),
    },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  esbuild: { jsx: "automatic" },
});
