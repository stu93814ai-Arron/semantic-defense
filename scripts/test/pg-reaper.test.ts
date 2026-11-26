/* eslint-disable security/detect-non-literal-fs-filename -- 測試夾具：路徑來自 mkdtemp */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { postmasterPid, reapDir } from "../pg-reaper.mjs";

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
  expect(existsSync(dir), dir).toBe(false);
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

function writePid(dir: string, text: string): void {
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "postmaster.pid"), text);
}

it("postmasterPid 拒絕 0、1、負數、非數字、小數、空白，接受 4242", () => {
  for (const text of ["0", "1", "-5", "abc", "1.5", "", " 2"]) {
    expect(postmasterPid(text), JSON.stringify(text)).toBeNull();
  }
  expect(postmasterPid("4242")).toBe(4242);
});

// 實作後 it.fails 已改回 it()。pid 檔未驗證前會對 -1 或別人的 pid 送 SIGKILL。
it("壞的 postmaster.pid 與不相干程序不會被守望殺掉", () => {
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

// 實作後 it.fails 已改回 it()。
it("只有這個資料目錄的 postgres 才殺，而且只有群組首領才殺整群", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-reaper-"));
  const driver = join(base, "driver.mjs");
  const url = pathToFileURL(REAPER).href;
  writeFileSync(driver, `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reapDir } from ${JSON.stringify(url)};
const base = process.argv[2];
const kills = [];
function once(name, pgid, argv0, dataDir, pidText) {
  const dir = join(base, name);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "postmaster.pid"), String(pidText || "4242") + "\\n");
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
once("init", 1, "postgres", data("init"), "1");
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
      [],
    ]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 只走注入的 kill／cmdline／pgid。process.kill 收到非 0 訊號會丟錯，測試行程不送訊號。
type KillCall = [number, string];
type ReapOutcome = { kills: KillCall[]; error: string | null };
type ReapHooks = {
  cmdline?: (pid: number) => Buffer | null;
  pgid?: (pid: number) => number | null;
};

function postgresArgv(argv0: string, dataDir: string): Buffer {
  return Buffer.from(`${argv0}\0-D\0${dataDir}\0`);
}

function guardRealKill(body: () => void): void {
  const real = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0) return real.call(process, pid, 0);
    throw new Error(`refusing ${String(signal)} to ${String(pid)}`);
  }) as typeof process.kill;
  try {
    body();
  } finally {
    process.kill = real;
  }
}

function reapKills(dir: string, hooks: ReapHooks): ReapOutcome {
  const kills: KillCall[] = [];
  let error: string | null = null;
  try {
    guardRealKill(() => {
      reapDir(dir, {
        ...hooks,
        kill: (pid: number, sig: string) => { kills.push([pid, String(sig)]); },
      });
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { kills, error };
}

function expectNoSignal(got: ReapOutcome, label: string): void {
  expect(got.kills, label).toEqual([]);
  expect(got.error ?? "", label).not.toContain("refusing");
}

it("postmasterPid 拒絕前導零，007 與 0042 都是 null", () => {
  const samples = ["007", "0042", "007\n", "0042\n"];
  expect(samples.map((text) => [text, postmasterPid(text)])).toEqual([
    ["007", null],
    ["0042", null],
    ["007\n", null],
    ["0042\n", null],
  ]);
});

it("pid 檔帶前導零時，守望不送任何 kill", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-reaper-"));
  try {
    const hits: string[] = [];
    for (const [text, numeric] of [["007", 7], ["0042", 42]] as const) {
      const dir = join(base, text);
      writePid(dir, `${text}\n`);
      const got = reapKills(dir, {
        cmdline: () => postgresArgv("postgres", join(dir, "data")),
        pgid: () => numeric,
      });
      if (got.kills.length > 0 || (got.error ?? "").includes("refusing")) hits.push(`${text} ${JSON.stringify(got)}`);
    }
    expect(hits).toEqual([]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("argv0 不是 postgres 本體、也不以 /postgres 結尾，就不殺", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-reaper-"));
  try {
    const hits: string[] = [];
    const names = ["/x/notpostgres", "postgres-evil", "/x/postgres.sh"] as const;
    let n = 0;
    for (const argv0 of names) {
      const dir = join(base, `bin-${n}`);
      n += 1;
      writePid(dir, "4242\n");
      const got = reapKills(dir, {
        cmdline: () => postgresArgv(argv0, join(dir, "data")),
        pgid: () => 4242,
      });
      if (got.kills.length > 0 || (got.error ?? "").includes("refusing")) hits.push(`${argv0} ${JSON.stringify(got)}`);
    }
    expect(hits).toEqual([]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("pgid 讀不到時只殺已驗證的 pid，不殺整群", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-reaper-"));
  try {
    const hooked = join(base, "hook-null");
    writePid(hooked, "4242\n");
    const nullPgid = reapKills(hooked, {
      cmdline: () => postgresArgv("postgres", join(hooked, "data")),
      pgid: () => null,
    });
    expect(nullPgid.error).toBeNull();
    expect(nullPgid.kills).toEqual([[4242, "SIGKILL"]]);

    const blew = join(base, "hook-throw");
    writePid(blew, "4242\n");
    const thrown = reapKills(blew, {
      cmdline: () => postgresArgv("postgres", join(blew, "data")),
      pgid: () => { throw new Error("pgid unreadable"); },
    });
    expectNoSignal(thrown, "pgid throw");

    // 不覆寫 pgid，讓 readPgid 讀一個高於 pid_max 的 pid。kill 與 cmdline 仍是 hook。
    const missingPid = Number(deadParent);
    const missing = join(base, "proc-missing");
    writePid(missing, `${missingPid}\n`);
    const read = reapKills(missing, {
      cmdline: () => postgresArgv("postgres", join(missing, "data")),
    });
    expect(read.error).toBeNull();
    expect(read.kills).toEqual([[missingPid, "SIGKILL"]]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("cmdline 讀不到時不送任何 kill", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-reaper-"));
  try {
    const missing = join(base, "null");
    writePid(missing, "4242\n");
    expectNoSignal(reapKills(missing, {
      cmdline: () => null,
      pgid: () => 4242,
    }), "null");
    const blew = join(base, "throw");
    writePid(blew, "4242\n");
    expectNoSignal(reapKills(blew, {
      cmdline: () => { throw new Error("cmdline unreadable"); },
      pgid: () => 4242,
    }), "throw");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("symlink 目錄只解除連結，不刪目標內容，也不殺程序", () => {
  const base = mkdtempSync(join(tmpdir(), "sd-reaper-"));
  try {
    const target = join(base, "target");
    writePid(target, "4242\n");
    writeFileSync(join(target, "payload"), "keep-this-bytes");
    const link = join(base, "link");
    symlinkSync(target, link);
    const got = reapKills(link, {
      cmdline: () => postgresArgv("postgres", join(link, "data")),
      pgid: () => 4242,
    });
    expectNoSignal(got, "symlink");
    expect(readFileSync(join(target, "payload"), "utf8")).toBe("keep-this-bytes");
    expect(readFileSync(join(target, "data", "postmaster.pid"), "utf8")).toBe("4242\n");
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(() => lstatSync(link)).toThrow();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
