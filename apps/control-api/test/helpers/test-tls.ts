import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 測試用自簽憑證（本機 fake server，不對外）。 */
export function makeSelfSigned(cn: string): { ca: string; cert: string; key: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sd-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", `/CN=${cn}`,
  ], { stdio: "pipe" });
  /* eslint-disable security/detect-non-literal-fs-filename -- mkdtemp 下的固定檔名 */
  const key = readFileSync(keyPath, "utf8");
  const cert = readFileSync(certPath, "utf8");
  /* eslint-enable security/detect-non-literal-fs-filename */
  return { ca: cert, cert, key, dispose: () => { rmSync(dir, { recursive: true, force: true }); } };
}

export type TlsHandler = (req: IncomingMessage, res: ServerResponse) => void;

export async function listenTls(creds: { cert: string; key: string }, handler: TlsHandler, host = "127.0.0.1"): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer({ key: creds.key, cert: creds.cert, minVersion: "TLSv1.2" }, handler);
  await new Promise<void>((ok) => { server.listen(0, host, ok); });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, close: () => new Promise((ok) => server.close(() => ok())) };
}
