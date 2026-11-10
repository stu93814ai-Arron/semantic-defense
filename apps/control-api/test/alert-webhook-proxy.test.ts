import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSelfSigned, listenTls } from "./helpers/test-tls.js";

const SECRET = "s".repeat(32);
const CN = "webhook.test";
const CHILD = join(dirname(fileURLToPath(import.meta.url)), "helpers", "send-webhook-once.mjs");

function spawnWebhook(env: NodeJS.ProcessEnv): Promise<{ status: number | null }> {
  const register = join(dirname(fileURLToPath(import.meta.url)), "helpers", "register-ts.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", "--import", register, CHILD], { env });
    const t = setTimeout(() => { child.kill("SIGTERM"); }, 15_000);
    child.on("exit", (status) => { clearTimeout(t); resolve({ status }); });
  });
}

describe("webhook proxy 隔離（子行程）", () => {
  const closes: Array<() => Promise<void> | void> = [];
  afterEach(async () => { while (closes.length) await closes.pop()!(); });

  it("NODE_USE_ENV_PROXY=1 且 HTTPS_PROXY 指向本機假 proxy 時，proxy 連線數為 0", async () => {
    const creds = makeSelfSigned(CN);
    closes.push(creds.dispose);
    let webhookHits = 0;
    const tls = await listenTls(creds, (_req, res) => { webhookHits += 1; res.statusCode = 200; res.end("ok"); });
    closes.push(tls.close);

    let proxyHits = 0;
    const proxy = http.createServer((_req, res) => { proxyHits += 1; res.end(); });
    proxy.on("connect", (_req, socket) => { proxyHits += 1; socket.end(); });
    proxy.on("connection", () => { proxyHits += 1; });
    await new Promise<void>((ok) => { proxy.listen(0, "127.0.0.1", ok); });
    const paddr = proxy.address();
    const pport = typeof paddr === "object" && paddr ? paddr.port : 0;
    closes.push(() => new Promise((ok) => proxy.close(() => ok())));

    const dir = mkdtempSync(join(tmpdir(), "sd-ca-"));
    /* eslint-disable security/detect-non-literal-fs-filename -- mkdtemp 下的固定檔名 */
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, creds.ca);
    /* eslint-enable security/detect-non-literal-fs-filename */
    closes.push(() => { rmSync(dir, { recursive: true, force: true }); });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: `http://127.0.0.1:${pport}`,
      https_proxy: `http://127.0.0.1:${pport}`,
      HTTP_PROXY: `http://127.0.0.1:${pport}`,
      ALL_PROXY: `http://127.0.0.1:${pport}`,
      SD_ALERT_WEBHOOK_URL: `https://${CN}:${tls.port}/hook`,
      SD_ALERT_WEBHOOK_HMAC_SECRET: SECRET,
      SD_ALERT_WEBHOOK_ALLOW_CIDRS: "127.0.0.0/8",
      SD_TEST_CA_FILE: caFile,
      SD_TEST_PIN_ADDR: "127.0.0.1",
    };
    delete env.NO_PROXY;
    delete env.no_proxy;
    delete env.noProxy;

    const result = await spawnWebhook(env);
    expect(proxyHits).toBe(0);
    expect(result.status).toBe(0);
    expect(webhookHits).toBe(1);
  });
});
