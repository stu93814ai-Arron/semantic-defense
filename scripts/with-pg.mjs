// 以拋棄式 Postgres 執行指令：
// - 環境已有 DATABASE_URL → 直接使用（不覆寫、不印出）
// - 否則若 apps/control-api 存在 → 用 embedded-postgres 在暫存目錄起一個叢集（隨機埠、隨機密碼），結束即刪除
// - 都不需要 → 直接執行
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

const [cmd, ...args] = process.argv.slice(2);
const run = (env) => spawnSync(cmd, args, { stdio: "inherit", env }).status ?? 1;
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

if (process.env.DATABASE_URL || (!existsSync("apps/control-api") && !process.env.CI_FORCE_PG)) process.exit(run(process.env));

const { default: EmbeddedPostgres } = await import("embedded-postgres");
const dir = mkdtempSync(join(tmpdir(), "sd-pg-"));
const port = await freePort();
const password = randomBytes(18).toString("hex");
const pg = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "ci", password, port, persistent: false, onLog: () => {} });
let code = 1;
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase("ci");
  console.log(`[with-pg] 拋棄式 Postgres 已啟動於 127.0.0.1:${port}`);
  code = run({ ...process.env, DATABASE_URL: `postgres://ci:${password}@127.0.0.1:${port}/ci` });
} finally {
  await pg.stop().catch(() => {}); rmSync(dir, { recursive: true, force: true });
}
process.exitCode = code;
