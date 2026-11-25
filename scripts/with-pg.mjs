// 以拋棄式 Postgres 執行指令：
// - 環境已有 DATABASE_URL → 直接使用（不覆寫、不印出）
// - 否則若 apps/control-api 存在 → 用 embedded-postgres 在暫存目錄起一個叢集（隨機埠、隨機密碼），結束即刪除
// - 都不需要 → 直接執行
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import "./detach-postgres.mjs";
import { currentChild, runChild } from "./run-child.mjs";
import { armClusterTerm, dropSigtermListeners, stopAndRemove } from "./pg-lifecycle.mjs";

const [cmd, ...args] = process.argv.slice(2);
// 不可用 spawnSync：那會停住這個行程的事件迴圈，Postgres stderr 沒人讀，後端寫 log 時抱著鎖卡住。
const run = (env) => runChild(cmd, args, env);
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

if (process.env.DATABASE_URL || (!existsSync("apps/control-api") && !process.env.CI_FORCE_PG)) process.exit(await run(process.env));

const { default: EmbeddedPostgres } = await import("embedded-postgres");
dropSigtermListeners();
let cluster = null;
let tempDir = null;
let cleaned = null;
const shutdown = () => {
  if (!cleaned) {
    const pid = cluster && cluster.process ? cluster.process.pid : undefined;
    cleaned = stopAndRemove(() => (cluster ? cluster.stop() : Promise.resolve()), tempDir, pid);
  }
  return cleaned;
};
armClusterTerm({ getChild: currentChild, shutdown, exit: (code) => process.exit(code) });

tempDir = mkdtempSync(join(tmpdir(), "sd-pg-"));
const port = await freePort();
const password = randomBytes(18).toString("hex");
cluster = new EmbeddedPostgres({ databaseDir: join(tempDir, "data"), user: "ci", password, port, persistent: false, onLog: () => {} });
let code = 1;
try {
  await cluster.initialise(); await cluster.start(); await cluster.createDatabase("sd_ci");
  console.log(`[with-pg] 拋棄式 Postgres 已啟動於 127.0.0.1:${port}`);
  code = await run({ ...process.env, DATABASE_URL: `postgres://ci:${password}@127.0.0.1:${port}/sd_ci` });
} finally {
  await shutdown();
}
process.exitCode = code;
