/* eslint-disable security/detect-non-literal-fs-filename -- 測試夾具：路徑來自 mkdtemp */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const REAPER = resolve(__dirname, "../pg-reaper.mjs");
const deadParent = String(Number(readFileSync("/proc/sys/kernel/pid_max", "utf8")) + 1000);

const HOOK = [
  'const fs = require("fs");',
  "const real = process.kill;",
  "process.kill = function(pid, signal) {",
  '  const sig = signal === undefined ? "SIGTERM" : String(signal);',
  '  if (sig === "0") return real.call(process, pid, 0);',
  '  fs.appendFileSync(process.env.KILL_LOG, String(pid) + " " + sig + "\\n");',
  "};",
  "",
].join("\n");

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function hookEnv(log: string): NodeJS.ProcessEnv {
  const env = { ...process.env, KILL_LOG: log };
  delete env.NODE_OPTIONS;
  return env;
}

/** 子行程裡的 kill 只寫進紀錄。先用自己的 sleep 證明 SIGKILL 沒有真的送出。 */
function proveHook(base: string, preload: string, sleepPid: number): void {
  const log = join(base, "probe.log");
  rmSync(log, { force: true });
  const probed = spawnSync(process.execPath, [
    "--require", preload, "-e", "process.kill(Number(process.argv[1]), 'SIGKILL')", String(sleepPid),
  ], { encoding: "utf8", env: hookEnv(log), timeout: 3000 });
  expect(probed.status, probed.stderr).toBe(0);
  expect(readFileSync(log, "utf8")).toBe(`${sleepPid} SIGKILL\n`);
  expect(pidAlive(sleepPid)).toBe(true);
}

function killLog(base: string, preload: string, dir: string): string {
  const log = join(base, "kills.log");
  rmSync(log, { force: true });
  const ran = spawnSync(process.execPath, ["--require", preload, REAPER, deadParent, dir], {
    encoding: "utf8", env: hookEnv(log), timeout: 3000,
  });
  expect(ran.error, ran.stderr).toBeUndefined();
  expect(ran.status, ran.stderr + ran.stdout).toBe(0);
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

function writePid(dir: string, text: string): void {
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "postmaster.pid"), text);
}

it.fails("壞的 postmaster.pid 與不相干程序不會被守望殺掉", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-reaper-"));
  const preload = join(base, "hook.cjs");
  writeFileSync(preload, HOOK);
  const sleep = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    proveHook(base, preload, sleep.pid!);
    for (const text of ["0\n", "1\n", "-5\n", "abc\n", "1.5\n"]) {
      const dir = mkdtempSync(join(base, "pid-"));
      writePid(dir, text);
      expect(killLog(base, preload, dir), text).toBe("");
    }
    const slept = mkdtempSync(join(base, "sleep-"));
    writePid(slept, `${sleep.pid}\n`);
    expect(killLog(base, preload, slept)).toBe("");
    expect(pidAlive(sleep.pid!)).toBe(true);
    const target = join(base, "target");
    writePid(target, "1\n");
    writeFileSync(join(target, "marker"), "keep");
    const link = join(base, "link");
    symlinkSync(target, link);
    expect(killLog(base, preload, link)).toBe("");
    expect(existsSync(join(target, "marker"))).toBe(true);
  } finally {
    if (sleep.pid) { try { process.kill(sleep.pid, "SIGKILL"); } catch { /* 已結束 */ } }
    rmSync(base, { recursive: true, force: true });
  }
});

it.fails("只有這個資料目錄的 postgres 才殺，而且只有群組首領才殺整群", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-reaper-"));
  const driver = join(base, "driver.mjs");
  const url = pathToFileURL(REAPER).href;
  writeFileSync(driver, `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reapDir } from ${JSON.stringify(url)};
const base = process.argv[2];
const kills = [];
function once(name, pgid, argv0, dataDir) {
  const dir = join(base, name);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "postmaster.pid"), "4242\\n");
  const seen = [];
  reapDir(dir, {
    kill: (pid, sig) => seen.push([pid, String(sig)]),
    cmdline: () => Buffer.from(argv0 + "\\0-D\\0" + dataDir + "\\0"),
    pgid: () => pgid,
  });
  kills.push(seen);
}
const data = (name) => join(base, name, "data");
once("leader", 4242, "postgres", data("leader"));
once("member", 50, "/usr/lib/postgresql/bin/postgres", data("member"));
once("other", 4242, "sleep", data("other"));
once("elsewhere", 4242, "postgres", "/tmp/not-this-cluster");
process.stdout.write(JSON.stringify(kills));
`);
  try {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const ran = spawnSync(process.execPath, [driver, base], { encoding: "utf8", env, timeout: 3000 });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toBe(JSON.stringify([
      [[-4242, "SIGKILL"]],
      [[4242, "SIGKILL"]],
      [],
      [],
    ]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
