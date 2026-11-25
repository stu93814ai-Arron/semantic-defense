/* eslint-disable security/detect-non-literal-fs-filename -- 測試夾具：路徑來自 mkdtemp 與本目錄腳本 */
/**
 * spawnSync 停住 with-pg 的事件迴圈時，Postgres stderr 寫滿後後端卡在 write()，鎖不放。
 * 必跑被 timeout 殺掉時要留下仍在跑的測試名稱與 pg_stat_activity。
 * 實作後 it.fails 已改回 it()。
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runChild } from "../run-child.mjs";
import { captureActivity, formatPartial, readServerSnapshot, setReportDir, startActivityLoop, writeRunning, writeSnapshot } from "../live-report.mjs";
import LiveReporter, { resetLiveReporter } from "../vitest-live-reporter.mjs";

const ROOT = resolve(__dirname, "../..");
const dirs: string[] = [];
const kids: { pid?: number; kill: (s: NodeJS.Signals) => boolean }[] = [];
afterEach(() => {
  resetLiveReporter();
  setReportDir("reports");
  for (const k of kids.splice(0)) {
    if (k.pid) { try { process.kill(-k.pid, "SIGKILL"); } catch { /* 程序群組已結束 */ } }
    try { k.kill("SIGKILL"); } catch { /* 已結束 */ }
  }
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

it("錯誤快照不蓋掉上一份有效的 pg-live", () => {
  const dir = scratch();
  writeSnapshot(dir, { activity: [{ query: "kept-row" }], locks: [] });
  writeSnapshot(dir, { error: "the database system is shutting down", activity: [], locks: [] });
  const live = text(join(dir, "pg-live.json"));
  expect(live).toContain("kept-row");
  expect(live).not.toContain("shutting down");
});

it("TERM 時資料庫正在關機，印出的仍是上一份有效快照", async () => {
  const dir = scratch();
  writeSnapshot(dir, {
    activity: [{ pid: 7, query: "INSERT INTO case_hits SELECT 'kept-row'" }],
    locks: [{ pid: 7, objid: 872364203 }],
  });
  const mod = JSON.stringify(resolve(__dirname, "../live-report.mjs"));
  const ready = join(dir, "ready");
  const childPath = join(dir, "child.mjs");
  writeFileSync(childPath, `import { writeFileSync } from "node:fs";
import { installKillSnapshot } from ${mod};
installKillSnapshot(${JSON.stringify(dir)}, async () => { throw new Error("the database system is shutting down"); });
writeFileSync(${JSON.stringify(ready)}, "1");
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [childPath], { stdio: "ignore" });
  kids.push(child);
  expect(await waitUntil(() => existsSync(ready), 2000)).toBe(true);
  child.kill("SIGTERM");
  expect(await Promise.race([once(child, "exit").then(() => true), delay(3000).then(() => false)])).toBe(true);
  const live = text(join(dir, "pg-live.json"));
  expect(live).toContain("kept-row");
  expect(live).not.toContain("shutting down");
  const dumped = spawnSync("bash", [resolve(__dirname, "../dump-partial.sh"), dir], { encoding: "utf8" });
  expect(dumped.stdout).toContain("kept-row");
});

const TERM_CHILD = `import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
writeFileSync(process.env.READY_FILE, "1");
process.on("SIGTERM", () => {
  const pg = createRequire(process.env.REQUIRE_FROM)("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1000 });
  client.on("error", () => {});
  client.connect().then(() => client.query("select 1")).then(() => client.end())
    .then(() => { writeFileSync(process.env.SNAP_FILE, "ok"); process.exit(0); })
    .catch((err) => { writeFileSync(process.env.SNAP_FILE, "fail " + err.message); process.exit(1); });
});
setInterval(() => {}, 1000);
`;

it("SIGTERM 等快照連線成功後才關 postgres，並刪掉 sd-pg 目錄", async () => {
  const base = scratch();
  const snap = join(base, "snap");
  const ready = join(base, "ready");
  const script = join(base, "child.mjs");
  writeFileSync(script, TERM_CHILD);
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: base, SNAP_FILE: snap, READY_FILE: ready, REQUIRE_FROM: join(ROOT, "package.json") };
  delete env.DATABASE_URL;
  const child = spawn(process.execPath, [resolve(ROOT, "scripts/with-pg.mjs"), process.execPath, script], {
    cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(child);
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  expect(await waitUntil(() => existsSync(ready), 20000)).toBe(true);
  process.kill(-child.pid!, "SIGTERM");
  expect(await Promise.race([once(child, "exit").then(() => true), delay(8000).then(() => false)])).toBe(true);
  expect(text(snap)).toBe("ok");
  const left = existsSync(base) ? readdirSync(base).filter((name) => name.startsWith("sd-pg-")) : ["missing"];
  expect(left).toEqual([]);
});

it("子行程被信號殺掉時不以 0 收場", async () => {
  const code = await runChild(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], process.env);
  expect(code).not.toBe(0);
});

it("spawn 失敗時不以 0 收場", async () => {
  const code = await runChild("/tmp/sd-no-such-bin-m5", [], process.env);
  expect(code).not.toBe(0);
});

it("退出碼是 null 時不以 0 收場", () => {
  const src = readFileSync(resolve(__dirname, "../run-child.mjs"), "utf8");
  const matched = src.match(/signal \? (\d+) : code \?\? (\d+)/);
  expect(matched?.[1]).toBe("1");
  expect(matched?.[2]).toBe("1");
});

it("query 截到約 200 字並遮罩字面值", async () => {
  const secret = "secret-token";
  const snap = await readServerSnapshot(async () => ({ rows: [{ query: `SELECT '${secret}', ${"Q".repeat(180)}` }] }));
  const query = String(snap.activity[0].query);
  expect(query).not.toContain(secret);
  expect(query).toContain("'?'");
  expect(query.length).toBeLessThanOrEqual(200);
});

it("快照 SQL 先取 2000 字，遮罩後才截到 200", async () => {
  const seen: string[] = [];
  await readServerSnapshot(async (sql) => { seen.push(sql); return { rows: [] }; });
  expect(seen[0]).toContain("left(query, 2000)");
  expect(seen[0]).not.toMatch(/left\(query, 200\)/);
});

async function maskedQuery(query: string) {
  const snap = await readServerSnapshot(async () => ({ rows: [{ query }] }));
  return String(snap.activity[0].query);
}

it("截斷切在字串中間時不會留下 SECRET_TRUNC", async () => {
  const raw = `${"Q".repeat(180)}'SECRET_TRUNC_${"Y".repeat(80)}`;
  expect(raw.slice(0, 200)).toContain("SECRET_TRUNC");
  const out = await maskedQuery(raw);
  expect(out).not.toContain("SECRET_TRUNC");
  expect(out.length).toBeLessThanOrEqual(200);
});

it("E 字串的反斜線引號不會讓 SECRET 漏出", async () => {
  const out = await maskedQuery("SELECT E'abc\\'SECRET'");
  expect(out).not.toContain("SECRET");
  expect(out).toContain("E'?'");
});

it("美元引號 $$SECRET$$ 會被遮住", async () => {
  expect(await maskedQuery("SELECT $$SECRET$$")).toBe("SELECT $$?$$");
});

it("帶標籤的美元引號 $tag$SECRET$tag$ 會被遮住", async () => {
  expect(await maskedQuery("SELECT $tag$SECRET$tag$")).toBe("SELECT $tag$?$tag$");
});

it("數字字面值會被遮住", async () => {
  expect(await maskedQuery("SELECT 4111111111111111")).toBe("SELECT ?");
});

it("沒閉合的引號遮到結尾", async () => {
  expect(await maskedQuery("SELECT 'SECRET")).toBe("SELECT '?'");
});

it("行註解裡的引號不會讓 SECRET_AFTER 露出", async () => {
  const out = await maskedQuery("-- it's\nSELECT 'SECRET_AFTER'");
  expect(out).not.toContain("SECRET_AFTER");
  expect(out).not.toContain("it's");
});

it("區塊註解裡的引號不會讓 SECRET_B2 露出", async () => {
  const out = await maskedQuery("/* don't */ SELECT 'SECRET_B2'");
  expect(out).not.toContain("SECRET_B2");
  expect(out).not.toContain("don't");
  expect(await maskedQuery("/* hunter2")).not.toContain("hunter2");
});

it("巢狀區塊註解不會在第一個結束處露出 hunter2", async () => {
  const out = await maskedQuery("/* a /* b */ 'x */ … pw='hunter2'");
  expect(out).not.toContain("hunter2");
});

it("巢狀區塊註解把 SECRET 留在註解裡", async () => {
  const out = await maskedQuery("/* /* */ SECRET */");
  expect(out).not.toContain("SECRET");
});

it("雙引號識別字裡的引號不會讓 SECRET_DQ 露出", async () => {
  const out = await maskedQuery("SELECT \"we'ird\", 'SECRET_DQ'");
  expect(out).not.toContain("SECRET_DQ");
  expect(out).toContain("\"we'ird\"");
  const escaped = await maskedQuery("SELECT \"we\"\"ird\", 'SECRET_DQ'");
  expect(escaped).toContain("\"we\"\"ird\"");
  expect(escaped).not.toContain("SECRET_DQ");
});

it("行註解整段遮掉", async () => {
  const out = await maskedQuery("SELECT 1 -- password hunter2");
  expect(out).not.toContain("hunter2");
  expect(out).not.toContain("password");
});

it("十六進位與指數整段遮成問號，識別字裡的數字保留", async () => {
  const nums = await maskedQuery("SELECT 0xFF, 1e10, 1.5E-3");
  expect(nums).not.toContain("FF");
  expect(nums).not.toContain("e10");
  expect(nums).not.toContain("E-3");
  const ids = await maskedQuery("SELECT table1, col_2");
  expect(ids).toContain("table1");
  expect(ids).toContain("col_2");
});

it("快照 SQL 先取 2000 字再遮罩", async () => {
  const seen: string[] = [];
  await readServerSnapshot(async (sql) => { seen.push(sql); return { rows: [] }; });
  expect(seen[0]).toContain("left(query, 2000)");
});

it("快照先讀 activity，不先取 advisory lock", async () => {
  const seen: string[] = [];
  await readServerSnapshot(async (sql) => { seen.push(sql); return { rows: [] }; });
  expect(seen[0]).toContain("pg_stat_activity");
  expect(seen.join("\n")).not.toMatch(/pg_advisory_(xact_)?lock\s*\(/);
});

it("快照連線有 statement、query、connection 逾時", () => {
  const src = readFileSync(resolve(__dirname, "../live-report.mjs"), "utf8");
  expect(src).toContain("connectionTimeoutMillis: 1000");
  expect(src).toContain("statement_timeout: 1000");
  expect(src).toContain("query_timeout: 1000");
});

it("connect 失敗仍 end，且 Client 聽 error", async () => {
  const events: string[] = [];
  let ended = false;
  const client = {
    on(event: string) { events.push(event); },
    async connect() { throw new Error("down"); },
    async query() { return { rows: [] }; },
    async end() { ended = true; },
  };
  await expect(captureActivity("postgres://ci@127.0.0.1:1/sd", () => client)).rejects.toThrow("down");
  expect(ended).toBe(true);
  expect(events).toContain("error");
});

it("快照用完會關掉連線", async () => {
  let ended = false;
  const client = {
    on() {},
    async connect() {},
    async query() { return { rows: [] }; },
    async end() { ended = true; },
  };
  await captureActivity("postgres://ci@127.0.0.1:1/sd", () => client);
  expect(ended).toBe(true);
});

it("第 2 輪跑前刪掉舊報告，退出碼非 0 且報告成功時不當通過", () => {
  const src = readFileSync(resolve(__dirname, "../tests.mjs"), "utf8");
  const body = src.slice(src.indexOf("function run"), src.indexOf("const a = run"));
  const dropAt = body.indexOf("discardReport(");
  expect(dropAt).toBeGreaterThanOrEqual(0);
  expect(dropAt).toBeLessThan(body.indexOf("execFileSync"));
  expect(src).toContain("round2ExitContradicts(");
});

it("第 2 輪退出碼非 0 或報告不是成功時，失敗數 0 也要失敗", async () => {
  const mod = await import("../tests.mjs");
  expect(mod.round2ExitContradicts(true, true, 0)).toBe(true);
  expect(mod.round2ExitContradicts(true, false, 0)).toBe(true);
  expect(mod.round2ExitContradicts(false, false, 0)).toBe(true);
  expect(mod.round2ExitContradicts(false, true, 0)).toBe(false);
  expect(mod.round2ExitContradicts(true, true, 2)).toBe(true);
});

it("numFailedTests 為 1 且該筆是 FLAKY 時放行", async () => {
  const mod = await import("../tests.mjs");
  const name = "suite > one";
  const explained = mod.flakyExplainedCount(new Map([[name, "failed"]]), new Map([[name, "passed"]]), new Set([name]));
  expect(explained).toBe(1);
  expect(mod.round2ExitContradicts(true, false, 1, explained)).toBe(false);
});

it("numFailedTests 為 2 但只有 1 筆可對應 FLAKY 時失敗", async () => {
  const mod = await import("../tests.mjs");
  const flaky = new Set(["suite > one"]);
  const other = new Map([["suite > one", "passed"], ["suite > two", "failed"]]);
  const onlyOne = new Map([["suite > one", "failed"]]);
  const both = new Map([["suite > one", "failed"], ["suite > two", "failed"]]);
  expect(mod.flakyExplainedCount(onlyOne, other, flaky)).toBe(1);
  expect(mod.round2ExitContradicts(true, false, 2, 1)).toBe(true);
  expect(mod.flakyExplainedCount(both, other, flaky)).toBe(1);
  expect(mod.round2ExitContradicts(true, false, 2, 1)).toBe(true);
});

it("第 2 輪用報告的 numFailedTests 對可解釋的 FLAKY", () => {
  const src = readFileSync(resolve(__dirname, "../tests.mjs"), "utf8");
  expect(src).toContain("numFailedTests: Number(r.numFailedTests) || 0");
  expect(src).toContain("flakyExplainedCount(b.m, a.m, flaky)");
  expect(src).toContain("loadRoundReport(");
  expect(src).toContain("round2ReportFails(");
  expect(src).toContain("classifyRounds(a.m, b.m)");
  expect(src).toContain("loadUnhandled(unhandledOut, startedAt)");
  expect(src).toContain("coverageBelow(");
  expect(src).not.toContain("round2ExitContradicts(b.exitFail, b.ok, failed.length)");
});

it("失敗對應必須是檔案加完整測試名稱，筆數要等於 numFailedTests", async () => {
  const mod = await import("../tests.mjs");
  const full = "Group case";
  const idA = mod.failureIdentity(`${process.cwd()}/apps/a.test.ts`, full);
  const idB = mod.failureIdentity(`${process.cwd()}/apps/b.test.ts`, full);
  expect(idA).toBe("apps/a.test.ts > Group case");
  expect(idB).not.toBe(idA);
  const report = {
    success: false,
    numFailedTests: 1,
    testResults: [{ name: `${process.cwd()}/apps/a.test.ts`, status: "failed", assertionResults: [{ fullName: full, status: "failed" }] }],
  };
  expect(mod.round2ReportFails(true, report, new Map([[idB, "passed"]]), new Set([idA, idB]))).toBe(true);
  expect(mod.round2ReportFails(true, report, new Map([[idA, "passed"]]), new Set([idA]))).toBe(false);
  expect(mod.round2ReportFails(true, { ...report, numFailedTests: 2 }, new Map([[idA, "passed"]]), new Set([idA]))).toBe(true);
});

it("報告沒有逐筆結果時無法對應，另一輪通過才算 FLAKY", async () => {
  const mod = await import("../tests.mjs");
  expect(mod.round2ReportFails(true, { success: false, numFailedTests: 1 }, new Map(), new Set())).toBe(true);
  const id = mod.failureIdentity("apps/a.test.ts", "Group case");
  const report = {
    success: false,
    numFailedTests: 1,
    testResults: [{ name: "apps/a.test.ts", status: "failed", assertionResults: [{ fullName: "Group case", status: "failed" }] }],
  };
  expect(mod.round2ReportFails(true, report, new Map([[id, "failed"]]), new Set([id]))).toBe(true);
  expect(mod.round2ReportFails(true, report, new Map([[id, "passed"]]), new Set([id]))).toBe(false);
});

it("suite 層級錯誤即使其餘是 FLAKY 也失敗", async () => {
  const mod = await import("../tests.mjs");
  const id = mod.failureIdentity("apps/a.test.ts", "Group case");
  const flakyCase = { name: "apps/a.test.ts", status: "failed", assertionResults: [{ fullName: "Group case", status: "failed" }] };
  const other = new Map([[id, "passed"]]);
  const flaky = new Set([id]);
  const imported = {
    success: false,
    numFailedTests: 1,
    testResults: [flakyCase, { name: "apps/b.test.ts", status: "failed", assertionResults: [], message: "Failed to import" }],
  };
  expect(mod.round2ReportFails(true, imported, other, flaky)).toBe(true);
});

it("第 1 輪 failed、第 2 輪缺席不算 FLAKY 且要失敗", async () => {
  const mod = await import("../tests.mjs");
  const id = "apps/a.test.ts > case";
  const out = mod.classifyRounds(new Map([[id, "failed"]]), new Map());
  expect(out.flaky).not.toContain(id);
  expect(out.failed).toContain(id);
  expect(mod.gateStops({ failedCount: out.failed.length, coverageFail: false, unhandled: false, total: 1, round2Lie: false })).toBe(true);
});

it("第 1 輪 passed、第 2 輪缺席或 skipped 不寫入 FLAKY", async () => {
  const mod = await import("../tests.mjs");
  const id = "apps/a.test.ts > case";
  const absent = mod.classifyRounds(new Map([[id, "passed"]]), new Map());
  const skipped = mod.classifyRounds(new Map([[id, "passed"]]), new Map([[id, "skipped"]]));
  expect(absent.flaky).not.toContain(id);
  expect(skipped.flaky).not.toContain(id);
  expect(absent.failed).toContain(id);
  expect(skipped.failed).toContain(id);
});

function unhandledFixture() {
  const root = mkdtempSync(join(ROOT, "reports", "unhandled-"));
  dirs.push(root);
  writeFileSync(join(root, "leak.test.ts"), "import { expect, it } from \"vitest\";\nit(\"ok\", () => { expect(1).toBe(1); });\nPromise.reject(new Error(\"boom-top\"));\n");
  writeFileSync(join(root, "vitest.config.ts"), "import { defineConfig } from \"vitest/config\";\nexport default defineConfig({ test: { include: [\"leak.test.ts\"], watch: false, fileParallelism: false } });\n");
  const countFile = join(root, "live", "unhandled.json");
  const json = join(root, "out.json");
  const started = Date.now();
  const r = spawnSync(process.execPath, [
    resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--root", root, "--config", join(root, "vitest.config.ts"),
    "--reporter=json", `--reporter=${resolve(__dirname, "../vitest-live-reporter.mjs")}`, `--outputFile=${json}`,
  ], { encoding: "utf8", env: { ...process.env, LIVE_REPORT_DIR: join(root, "live"), UNHANDLED_REPORT: countFile }, cwd: ROOT });
  return { r, json, countFile, started };
}

it("真實 vitest 的未處理 rejection 寫進獨立檔", () => {
  const { r, json, countFile } = unhandledFixture();
  expect(r.status, r.stdout + r.stderr).not.toBe(0);
  const report = JSON.parse(text(json));
  expect(report.success).toBe(true);
  expect(report.numFailedTests).toBe(0);
  expect(report.unhandledErrors).toBeUndefined();
  expect(text(countFile)).toContain("\"count\":1");
});

it("未處理錯誤檔缺、壞或舊就失敗", async () => {
  const mod = await import("../tests.mjs");
  const dir = scratch();
  expect(mod.loadUnhandled(join(dir, "missing.json"), Date.now()).ok).toBe(false);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{");
  expect(mod.loadUnhandled(bad, 0).ok).toBe(false);
  const old = join(dir, "old.json");
  writeFileSync(old, "{\"count\":0}\n");
  utimesSync(old, 1, 1);
  expect(mod.loadUnhandled(old, Date.now()).ok).toBe(false);
});

it("未處理錯誤加上一筆 FLAKY 時退出碼不是 0", async () => {
  const mod = await import("../tests.mjs");
  const { countFile } = unhandledFixture();
  const count = JSON.parse(text(countFile)).count;
  const id = "apps/a.test.ts > case";
  const out = mod.classifyRounds(new Map([[id, "failed"]]), new Map([[id, "passed"]]));
  expect(out.failed).not.toContain(id);
  expect(count).toBeGreaterThan(0);
  expect(mod.gateStops({ failedCount: out.failed.length, coverageFail: false, unhandled: count > 0, total: 1, round2Lie: false })).toBe(true);
});

it("主程式讀未處理錯誤檔，不再看報告裡的 unhandledErrors", () => {
  const src = readFileSync(resolve(__dirname, "../tests.mjs"), "utf8");
  expect(src).toContain("loadUnhandled(unhandledOut, startedAt)");
  expect(src).toContain("UNHANDLED_REPORT: unhandledOut");
  expect(src).toContain("discardReport(unhandledOut)");
  expect(src).not.toContain("hasUnhandled(a.report)");
  expect(src).not.toContain("report.unhandledErrors");
});

it("覆蓋率摘要缺了或壞了就失敗", async () => {
  const mod = await import("../tests.mjs");
  expect(mod.coverageBelow(null)).toBe(true);
  expect(mod.coverageBelow({})).toBe(true);
  const dir = scratch();
  expect(mod.loadCoverageSummary(join(dir, "missing.json"), Date.now()).ok).toBe(false);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{");
  expect(mod.loadCoverageSummary(bad, 0).ok).toBe(false);
});

it("覆蓋率摘要太舊就失敗", async () => {
  const mod = await import("../tests.mjs");
  const dir = scratch();
  const old = join(dir, "old.json");
  writeFileSync(old, "{\"total\":{\"lines\":{\"pct\":99},\"statements\":{\"pct\":99},\"functions\":{\"pct\":99},\"branches\":{\"pct\":99}}}\n");
  utimesSync(old, 1, 1);
  expect(mod.loadCoverageSummary(old, Date.now()).ok).toBe(false);
  const stamped = join(dir, "stamped.json");
  writeFileSync(stamped, "{\"startTime\":1,\"total\":{\"lines\":{\"pct\":99},\"statements\":{\"pct\":99},\"functions\":{\"pct\":99},\"branches\":{\"pct\":99}}}\n");
  expect(mod.loadCoverageSummary(stamped, Date.now()).ok).toBe(false);
});

it("覆蓋率摘要少欄位或 pct 不是數字就失敗", async () => {
  const mod = await import("../tests.mjs");
  const full = { statements: { pct: 90 }, functions: { pct: 90 }, branches: { pct: 90 } };
  expect(mod.coverageBelow({ total: full })).toBe(true);
  expect(mod.coverageBelow({ total: { ...full, lines: { pct: null } } })).toBe(true);
  expect(mod.coverageBelow({ total: { ...full, lines: { pct: "Unknown" } } })).toBe(true);
  expect(mod.coverageBelow({ total: { ...full, lines: { pct: "96.88" } } })).toBe(true);
});

it("覆蓋率摘要有問題時，一筆 FLAKY 仍要失敗", async () => {
  const mod = await import("../tests.mjs");
  const id = "apps/a.test.ts > case";
  const out = mod.classifyRounds(new Map([[id, "failed"]]), new Map([[id, "passed"]]));
  const coverageFail = mod.coverageBelow(null);
  expect(out.failed).not.toContain(id);
  expect(coverageFail).toBe(true);
  expect(mod.gateStops({ failedCount: out.failed.length, coverageFail, unhandled: false, total: 1, round2Lie: false })).toBe(true);
});

it("主程式有接上覆蓋率摘要檢查", () => {
  const src = readFileSync(resolve(__dirname, "../tests.mjs"), "utf8");
  expect(src).toContain("loadCoverageSummary(\"reports/coverage/coverage-summary.json\"");
  expect(src).toContain("coverageBelow(coverage.summary)");
});

it("非覆蓋率的非 0 退出碼印中性訊息", async () => {
  const mod = await import("../tests.mjs");
  expect(mod.round1ExitMessage(false, true)).toBe("第 1 輪退出碼非 0");
  expect(mod.round1ExitMessage(true, true)).toContain("覆蓋率低於 70%");
  const src = readFileSync(resolve(__dirname, "../tests.mjs"), "utf8");
  expect(src).toContain("round1ExitMessage(summaryFail, exitFail)");
});

it("第 1 輪 unhandled 或覆蓋率不足時，一筆 FLAKY 仍要失敗", async () => {
  const mod = await import("../tests.mjs");
  const id = "apps/a.test.ts > case";
  const out = mod.classifyRounds(new Map([[id, "failed"]]), new Map([[id, "passed"]]));
  expect(out.flaky).toContain(id);
  expect(out.failed).not.toContain(id);
  const flags = { failedCount: out.failed.length, coverageFail: false, unhandled: true, total: 1, round2Lie: false };
  expect(mod.gateStops(flags)).toBe(true);
  expect(mod.coverageBelow({ total: { lines: { pct: 69 }, statements: { pct: 90 }, functions: { pct: 90 }, branches: { pct: 90 } } })).toBe(true);
  expect(mod.gateStops({ ...flags, unhandled: false, coverageFail: true })).toBe(true);
});

it("第 2 輪報告不存在、解析失敗或是開跑前的舊檔就失敗", async () => {
  const mod = await import("../tests.mjs");
  const dir = scratch();
  expect(mod.loadRoundReport(join(dir, "missing.json"), Date.now()).ok).toBe(false);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{");
  expect(mod.loadRoundReport(bad, 0).ok).toBe(false);
  const old = join(dir, "old.json");
  writeFileSync(old, "{\"success\":true,\"numFailedTests\":0,\"testResults\":[]}");
  utimesSync(old, 1, 1);
  expect(mod.loadRoundReport(old, Date.now()).ok).toBe(false);
  const fresh = join(dir, "fresh.json");
  writeFileSync(fresh, "{\"success\":true,\"numFailedTests\":0,\"testResults\":[]}");
  expect(mod.loadRoundReport(fresh, Date.now() - 5000).ok).toBe(true);
});

it("停不住的 postmaster 會在時限內收到 SIGKILL", async () => {
  const mod = await import("../pg-lifecycle.mjs");
  expect(mod.STOP_MS).toBe(5000);
  expect(typeof mod.stopWithin).toBe("function");
  const signals: string[] = [];
  const started = Date.now();
  await mod.stopWithin(() => new Promise(() => {}), 4321, 200, (pid: number, sig: string) => {
    signals.push(`${pid}:${sig}`);
  });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(signals).toEqual(["4321:SIGKILL"]);
});

it("SIGSTOP 的 postmaster 在 5 秒內被程序群組 SIGKILL", async () => {
  const mod = await import("../pg-lifecycle.mjs");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  kids.push(child);
  await once(child, "spawn");
  const exit = once(child, "exit");
  process.kill(child.pid!, "SIGSTOP");
  const started = Date.now();
  await mod.stopWithin(() => new Promise(() => {}), child.pid);
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(8000);
  expect(elapsed).toBeGreaterThan(4000);
  const exited = await Promise.race([exit, delay(1000).then(() => null)]);
  expect(exited?.[1]).toBe("SIGKILL");
});

it("停得下來的 postgres 不會被 SIGKILL", async () => {
  const mod = await import("../pg-lifecycle.mjs");
  const signals: string[] = [];
  await mod.stopWithin(async () => {}, 4321, 200, (pid: number, sig: string) => { signals.push(`${pid}:${sig}`); });
  expect(signals).toEqual([]);
});

it("停 postgres 逾時會對程序群組 SIGKILL", () => {
  const life = readFileSync(resolve(__dirname, "../pg-lifecycle.mjs"), "utf8");
  const boot = readFileSync(resolve(__dirname, "../with-pg.mjs"), "utf8");
  expect(life).toContain("process.kill(-pid, signal)");
  expect(life).toContain("await stopWithin(stop, pid)");
  expect(boot).toContain("cluster.process.pid");
});

function writeFlakyProject(hook: boolean) {
  const root = mkdtempSync(join(ROOT, "reports", "flaky-"));
  dirs.push(root);
  writeFileSync(join(root, "covered.ts"), "export function covered(n: number) { return n + 1; }\n");
  const imports = hook ? "afterAll, expect, it" : "expect, it";
  const hookLine = hook ? "afterAll(() => { if (process.env.HOOK === \"1\") throw new Error(\"hook-boom\"); });\n" : "";
  writeFileSync(join(root, "flaky.test.ts"), `import { ${imports} } from "vitest";\nimport { covered } from "./covered";\nit("steady", () => { expect(covered(0)).toBe(1); });\nit("case", () => { expect(covered(1)).toBe(process.env.ROUND === "1" ? 1 : 2); });\n${hookLine}`);
  const cov = JSON.stringify(join(root, "cov"));
  const configPath = JSON.stringify(join(ROOT, "vitest.config.ts"));
  writeFileSync(join(root, "vitest.config.ts"), `import { defineConfig } from "vitest/config";\nimport rootConfig from ${configPath};\nconst base = rootConfig.test.coverage;\nexport default defineConfig({ test: { include: ["flaky.test.ts"], watch: false, fileParallelism: false,\n  coverage: { ...base, include: ["covered.ts"], reportsDirectory: ${cov}, reporter: ["json-summary"] } } });\n`);
  return root;
}

function runFixture(root: string, env: Record<string, string>, outName: string, coverage: boolean) {
  const json = join(root, outName);
  const args = [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--root", root, "--config", join(root, "vitest.config.ts")];
  if (coverage) args.push("--coverage");
  args.push("--reporter=json", `--outputFile=${json}`);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env, LIVE_REPORT_DIR: join(root, "live") }, cwd: ROOT });
  return { r, json };
}

it.fails("真 FLAKY 仍寫出覆蓋率摘要且只把該筆列入 flaky", async () => {
  const src = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  expect(src).toContain("reportOnFailure: true");
  const root = writeFlakyProject(false);
  const started = Date.now() - 5000;
  const first = runFixture(root, { ROUND: "1" }, "run1.json", true);
  expect(first.r.status, first.r.stdout + first.r.stderr).not.toBe(0);
  expect(existsSync(join(root, "cov", "coverage-summary.json"))).toBe(true);
  const second = runFixture(root, { ROUND: "2" }, "run2.json", false);
  expect(second.r.status, second.r.stdout + second.r.stderr).toBe(0);
  const mod = await import("../tests.mjs");
  const round = (file: string, exitFail: boolean) => {
    const report = JSON.parse(text(file));
    const m = new Map<string, string>();
    for (const suite of report.testResults) for (const row of suite.assertionResults) m.set(mod.failureIdentity(suite.name, row.fullName), row.status);
    return { m, exitFail, ok: report.success, numFailedTests: report.numFailedTests, report, unhandled: { ok: true, count: 0 }, startedAt: started };
  };
  const outcome = mod.judge(round(first.json, true), round(second.json, false), join(root, "cov", "coverage-summary.json"));
  const caseId = mod.failureIdentity(join(root, "flaky.test.ts"), "case");
  expect(outcome.stop).toBe(false);
  expect([...outcome.flaky].sort()).toEqual([caseId]);
});

it.fails("第 1 輪 afterAll 拋錯加上一筆 FLAKY 時退出碼不是 0", async () => {
  const root = writeFlakyProject(true);
  const first = runFixture(root, { ROUND: "1", HOOK: "1" }, "run1.json", false);
  const second = runFixture(root, { ROUND: "2" }, "run2.json", false);
  expect(first.r.status, first.r.stdout + first.r.stderr).not.toBe(0);
  expect(second.r.status, second.r.stdout + second.r.stderr).toBe(0);
  const mod = await import("../tests.mjs");
  const report = JSON.parse(text(first.json));
  const caseId = mod.failureIdentity(report.testResults[0].name, "case");
  expect(mod.round2ReportFails(true, report, new Map([[caseId, "passed"]]), new Set([caseId]))).toBe(true);
  const summary = join(root, "summary.json");
  writeFileSync(summary, "{\"total\":{\"lines\":{\"pct\":100},\"statements\":{\"pct\":100},\"functions\":{\"pct\":100},\"branches\":{\"pct\":100}}}\n");
  const started = Date.now() - 5000;
  const asRun = (file: string, exitFail: boolean) => {
    const body = JSON.parse(text(file));
    const m = new Map<string, string>();
    for (const suite of body.testResults) for (const row of suite.assertionResults ?? []) m.set(mod.failureIdentity(suite.name, row.fullName), row.status);
    return { m, exitFail, ok: body.success, numFailedTests: body.numFailedTests, report: body, unhandled: { ok: true, count: 0 }, startedAt: started };
  };
  const outcome = mod.judge(asRun(first.json, true), asRun(second.json, false), summary);
  expect(outcome.flaky).toContain(caseId);
  expect(outcome.stop).toBe(true);
  expect(readFileSync(resolve(__dirname, "../tests.mjs"), "utf8")).toContain("suiteLevelFailure(a.report)");
});

it("開跑前刪掉舊的 vitest 報告", async () => {
  const mod = await import("../tests.mjs");
  const dir = scratch();
  const out = join(dir, "vitest-run2.json");
  writeFileSync(out, "{\"success\":true}");
  mod.discardReport(out);
  expect(existsSync(out)).toBe(false);
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
