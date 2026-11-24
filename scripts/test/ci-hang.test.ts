/* eslint-disable security/detect-non-literal-fs-filename -- 測試夾具：路徑來自 mkdtemp 與本目錄腳本 */
/**
 * spawnSync 停住 with-pg 的事件迴圈時，Postgres stderr 寫滿後後端卡在 write()，鎖不放。
 * 必跑被 timeout 殺掉時要留下仍在跑的測試名稱與 pg_stat_activity。
 * 實作後 it.fails 已改回 it()。
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runChild } from "../run-child.mjs";
import { formatPartial, readServerSnapshot, setReportDir, startActivityLoop, writeRunning, writeSnapshot } from "../live-report.mjs";
import LiveReporter, { resetLiveReporter } from "../vitest-live-reporter.mjs";

const ROOT = resolve(__dirname, "../..");
const dirs: string[] = [];
const kids: { kill: (s: NodeJS.Signals) => boolean }[] = [];
afterEach(() => {
  resetLiveReporter();
  setReportDir("reports");
  for (const k of kids.splice(0)) k.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scratch = () => { const d = mkdtempSync(join(tmpdir(), "sd-hang-")); dirs.push(d); return d; };
const text = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await delay(20); }
  return false;
}

const DRAIN_BYTES = 128 * 1024;
const LOGGER = `const chunk = Buffer.alloc(1024, 97); let left = 128;
function write(){ while (left > 0) { left -= 1; if (!process.stderr.write(Buffer.from(chunk))) { process.stderr.once("drain", write); return; } } process.stderr.end(); }
process.stderr.on("finish", () => process.exit(0));
write();`;
const sleeperUntil = (flag: string) => `const fs=require("fs"); const f=${JSON.stringify(flag)}; const end=Date.now()+3000; const t=setInterval(()=>{ if (fs.existsSync(f)||Date.now()>end){ clearInterval(t); process.exit(0);} }, 10);`;

it("子行程執行期間仍排空其他 stderr，寫滿管道也不會堵住", async () => {
  const flag = join(scratch(), "drained");
  const logger = spawn(process.execPath, ["-e", LOGGER], { stdio: ["ignore", "ignore", "pipe"] });
  kids.push(logger);
  if (!logger.stderr) throw new Error("logger stderr missing");
  let bytes = 0;
  logger.stderr.on("data", (c: Buffer) => { bytes += c.length; if (bytes >= DRAIN_BYTES) writeFileSync(flag, "1"); });
  await runChild(process.execPath, ["-e", sleeperUntil(flag)], process.env);
  expect(bytes).toBe(DRAIN_BYTES);
});

it("with-pg 用 runChild，不再呼叫 spawnSync", () => {
  const src = readFileSync(resolve(__dirname, "../with-pg.mjs"), "utf8");
  expect(src.includes("runChild(")).toBe(true);
  expect(/spawnSync\s*\(/.test(src)).toBe(false);
});

it("快照查詢會讀 pg_stat_activity 與 pg_locks", async () => {
  const seen: string[] = [];
  const snap = await readServerSnapshot(async (sql) => { seen.push(sql); return { rows: [{ pid: 1 }] }; });
  expect(seen.join("\n")).toContain("pg_stat_activity");
  expect(seen.join("\n")).toContain("pg_locks");
  expect(snap.activity).toEqual([{ pid: 1 }]);
  expect(snap.locks).toEqual([{ pid: 1 }]);
});

it("測試一開始就寫入仍在跑的名稱，結束後從清單拿掉", async () => {
  const dir = scratch();
  setReportDir(dir);
  const reporter = new LiveReporter();
  const hang = { id: "1", fullName: "卡住的測試", module: { moduleId: "apps/control-api/test/judge-tick.test.ts" } };
  await reporter.onTestCaseReady(hang);
  const file = join(dir, "vitest-live.json");
  expect(text(file)).toContain("judge-tick.test.ts > 卡住的測試");
  await reporter.onTestCaseResult(hang);
  expect(text(file)).toContain("\"running\":[]");
});

it("SIGTERM 時留下測試名稱與 pg 快照", async () => {
  const dir = scratch();
  const mod = JSON.stringify(resolve(__dirname, "../live-report.mjs"));
  const childPath = join(dir, "child.mjs");
  writeFileSync(childPath, `import { installKillSnapshot, writeRunning } from ${mod};
installKillSnapshot(${JSON.stringify(dir)}, async () => ({
  activity: [{ pid: 7, application_name: "ci", state: "active", wait_event: null, query: "INSERT INTO case_hits" }],
  locks: [{ pid: 7, locktype: "advisory", mode: "ExclusiveLock", granted: true, objid: 872364203 }],
}));
writeRunning(${JSON.stringify(dir)}, ["apps/control-api/test/judge-tick.test.ts > 卡住的測試"]);
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [childPath], { stdio: "ignore" });
  kids.push(child);
  await waitUntil(() => existsSync(join(dir, "vitest-live.json")), 2000);
  child.kill("SIGTERM");
  const exited = await Promise.race([once(child, "exit").then(() => true), delay(3000).then(() => false)]);
  expect(exited).toBe(true);
  expect(text(join(dir, "vitest-live.json"))).toContain("卡住的測試");
  expect(text(join(dir, "pg-live.json"))).toContain("INSERT INTO case_hits");
  expect(text(join(dir, "pg-live.json"))).toContain("872364203");
});

it("週期快照寫入 pg-live.json", async () => {
  const dir = scratch();
  const stop = startActivityLoop(dir, async () => ({
    activity: [{ query: "SELECT pg_advisory_lock($1)", state: "active", wait_event: null }],
    locks: [{ objid: 872364201, locktype: "advisory", granted: true }],
  }));
  try {
    await waitUntil(() => existsSync(join(dir, "pg-live.json")), 1000);
    expect(text(join(dir, "pg-live.json"))).toContain("pg_advisory_lock");
    expect(text(join(dir, "pg-live.json"))).toContain("872364201");
  } finally { stop(); }
});

it("部分報告含仍在跑的測試與 activity", () => {
  const dir = scratch();
  writeRunning(dir, ["file > stuck"]);
  writeSnapshot(dir, { activity: [{ query: "INSERT", wait_event: null, application_name: "" }], locks: [] });
  const partial = formatPartial(dir);
  expect(partial).toContain("file > stuck");
  expect(partial).toContain("INSERT");
});

it("dump-partial 印出仍在跑的測試與 pg 快照", () => {
  const dir = scratch();
  writeRunning(dir, ["file > stuck"]);
  writeSnapshot(dir, { activity: [{ query: "INSERT", wait_event: null }], locks: [] });
  const dumped = spawnSync("bash", [resolve(__dirname, "../dump-partial.sh"), dir], { encoding: "utf8" });
  expect(dumped.status).toBe(0);
  expect(dumped.stdout).toContain("file > stuck");
  expect(dumped.stdout).toContain("INSERT");
});

it("必跑腳本接上 live reporter，被殺時會印部分報告", () => {
  const tests = readFileSync(resolve(__dirname, "../tests.mjs"), "utf8");
  const required = readFileSync(resolve(__dirname, "../required.sh"), "utf8");
  expect(tests).toContain("--reporter=./scripts/vitest-live-reporter.mjs");
  expect(tests).toContain("formatPartial(");
  expect(required).toContain("dump-partial.sh");
  expect(required).toContain("TERM");
});

it("json reporter 與 live reporter 可同時跑", async () => {
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  const dir = mkdtempSync(join(ROOT, "reports", "live-"));
  dirs.push(dir);
  writeFileSync(join(dir, "ok.test.ts"), 'import { expect, it } from "vitest";\nit("活報告", () => { expect(1).toBe(1); });\n');
  writeFileSync(join(dir, "vitest.config.ts"), 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["ok.test.ts"], watch: false, fileParallelism: false } });\n');
  const json = join(dir, "out.json");
  const live = join(dir, "live");
  const r = spawnSync(process.execPath, [
    resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--root", dir, "--config", join(dir, "vitest.config.ts"),
    "--reporter=json", `--reporter=${resolve(__dirname, "../vitest-live-reporter.mjs")}`, `--outputFile=${json}`,
  ], { encoding: "utf8", env: { ...process.env, LIVE_REPORT_DIR: live }, cwd: ROOT });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(text(json)).toContain("活報告");
  expect(text(join(live, "vitest-live.json"))).toContain("\"running\"");
});
