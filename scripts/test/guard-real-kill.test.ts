/* eslint-disable security/detect-non-literal-fs-filename -- 掃描測試檔與讀 pid_max，路徑不是使用者輸入 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const GUARD = join(__dirname, "guard-real-kill.cjs");
const SKIP = new Set(["node_modules", "dist", "reports", "coverage", "playwright-report", "test-results", ".git"]);

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}

function absentPid(): number {
  const max = Number(readFileSync("/proc/sys/kernel/pid_max", "utf8"));
  const pid = max + 1000;
  expect(pidGone(pid), String(pid)).toBe(true);
  expect(groupGone(pid), String(-pid)).toBe(true);
  return pid;
}

const PROBE = [
  "const pid = Number(process.argv[1]);",
  "function hit(target, signal) {",
  "  try { process.kill(target, signal); return \"sent\"; }",
  "  catch (err) {",
  "    const code = err && err.code ? String(err.code) + \" \" : \"\";",
  "    return code + String((err && err.message) || err);",
  "  }",
  "}",
  "process.stdout.write(JSON.stringify({",
  "  positive: hit(pid, \"SIGKILL\"),",
  "  negative: hit(-pid, \"SIGKILL\"),",
  "  probe: hit(pid, 0),",
  "}));",
].join("\n");

it("守衛子程序擋下 SIGKILL，負 pid 也擋，signal 0 仍是真的探測", () => {
  const pid = absentPid();
  const ran = spawnSync(process.execPath, [
    "--require", join(__dirname, "guard-real-kill.cjs"), "-e", PROBE, String(pid),
  ], { encoding: "utf8", env: cleanEnv(), timeout: 3000 });
  expect(ran.status, ran.stderr).toBe(0);
  const body = JSON.parse(ran.stdout) as { positive: string; negative: string; probe: string };
  expect(body.positive).toBe(`refusing SIGKILL to ${pid}`);
  expect(body.negative).toBe(`refusing SIGKILL to ${-pid}`);
  expect(body.probe).not.toContain("refusing");
  expect(body.probe).toContain("ESRCH");
  expect(pidGone(pid)).toBe(true);
  expect(groupGone(pid)).toBe(true);
});

it("allowlist 只放行子程序自己的 pid，自我 SIGKILL 仍送得出去", () => {
  const ran = spawnSync(process.execPath, [
    "--require", join(__dirname, "guard-real-kill.cjs"),
    "-e", "process.kill(process.pid, 'SIGKILL'); process.stdout.write('still-alive')",
  ], { encoding: "utf8", env: cleanEnv({ SD_KILL_ALLOW: "self" }), timeout: 3000 });
  expect(ran.signal, ran.stderr).toBe("SIGKILL");
  expect(ran.stdout ?? "").not.toContain("still-alive");
});

// 假 kill 必須先於 guard 載入，guard 存到的底層才是假的。0 與 -1 就算 guard 放行也不會進系統。
const FAKE_UNDERLYING = [
  '"use strict";',
  'const fs = require("fs");',
  "process.kill = function fakeUnderlyingKill(pid, signal) {",
  '  fs.appendFileSync(process.env.SD_FAKE_KILL_LOG, String(pid) + " " + String(signal) + "\\n");',
  '  throw new Error("fake-kill");',
  "};",
  "",
].join("\n");

const SELF_HITS = [
  "const foreign = Number(process.env.SD_KILL_TARGET);",
  "const targets = [foreign, -process.pid, 0, -1, \"self\"];",
  "function hit(target) {",
  "  try { process.kill(target, \"SIGKILL\"); return \"sent\"; }",
  "  catch (err) { return String((err && err.message) || err); }",
  "}",
  "process.stdout.write(JSON.stringify({ pid: process.pid, hits: targets.map(hit) }));",
].join("\n");

const STRING_PID = [
  "const pid = process.pid;",
  "let message = \"sent\";",
  "try { process.kill(String(pid), \"SIGKILL\"); }",
  "catch (err) { message = String((err && err.message) || err); }",
  "process.stdout.write(JSON.stringify({ pid: pid, message: message }));",
].join("\n");

const ONE_PID = [
  "const target = Number(process.env.SD_KILL_TARGET);",
  "try { process.kill(target, \"SIGKILL\"); process.stdout.write(\"sent\"); }",
  "catch (err) { process.stdout.write(String((err && err.message) || err)); }",
].join("\n");

function withKillStub(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sd-fake-kill-"));
  writeFileSync(join(dir, "fake.cjs"), FAKE_UNDERLYING);
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function spawnGuarded(dir: string, allow: string, script: string, arg: string) {
  const log = join(dir, "kills.log");
  rmSync(log, { force: true });
  const ran = spawnSync(process.execPath, [
    "--require", join(dir, "fake.cjs"), "--require", join(__dirname, "guard-real-kill.cjs"), "-e", script,
  ], {
    encoding: "utf8",
    env: cleanEnv({ SD_KILL_ALLOW: allow, SD_FAKE_KILL_LOG: log, SD_KILL_TARGET: arg }),
    timeout: 3000,
  });
  return {
    status: ran.status,
    stdout: ran.stdout ?? "",
    stderr: ran.stderr ?? "",
    log: existsSync(log) ? readFileSync(log, "utf8") : "",
  };
}

it("self 不放行高 pid、-自己、0、-1 與字串 self", () => {
  const foreign = absentPid();
  withKillStub((dir) => {
    const got = spawnGuarded(dir, "self", SELF_HITS, String(foreign));
    expect(got.status, got.stderr).toBe(0);
    expect(got.log, got.stdout).toBe("");
    const body = JSON.parse(got.stdout) as { pid: number; hits: string[] };
    expect(body.hits).toEqual([
      `refusing SIGKILL to ${foreign}`,
      `refusing SIGKILL to ${-body.pid}`,
      "refusing SIGKILL to 0",
      "refusing SIGKILL to -1",
      "refusing SIGKILL to self",
    ]);
    expect(pidGone(foreign)).toBe(true);
  });
});

it("self 不放行字串形式的自己的 pid", () => {
  withKillStub((dir) => {
    const got = spawnGuarded(dir, "self", STRING_PID, "0");
    expect(got.status, got.stderr).toBe(0);
    expect(got.log, got.stdout).toBe("");
    const body = JSON.parse(got.stdout) as { pid: number; message: string };
    expect(body.message).toBe(`refusing SIGKILL to ${body.pid}`);
  });
});

it("SD_KILL_ALLOW 設成 4242 或 -4242 也不放行", () => {
  withKillStub((dir) => {
    for (const target of [4242, -4242]) {
      const got = spawnGuarded(dir, String(target), ONE_PID, String(target));
      expect(got.log, `${target} ${got.stdout}`).toBe("");
      expect(got.stdout, got.stderr).toBe(`refusing SIGKILL to ${target}`);
    }
  });
});

function listTests(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listTests(path, out);
    else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) out.push(path);
  }
}

function nodeMiss(source: string, file: string): string[] {
  const hits: string[] = [];
  const re = /(?:spawnSync|spawn|execFileSync|execFile|fork|runChild)\(\s*(?:process\.execPath|["']node["'])\s*,\s*([\s\S]{0,240})/g;
  for (const match of source.matchAll(re)) {
    const head = match[1] ?? "";
    if (head.includes("guardedNodeArgs") || head.includes("guard-real-kill.cjs") || head.includes("GUARD_REAL_KILL")) continue;
    hits.push(`${file}: ${head.slice(0, 60).replace(/\s+/g, " ")}`);
  }
  return hits;
}

function bashMiss(source: string, file: string): string[] {
  const hits: string[] = [];
  const re = /(?:spawnSync|spawn|execFileSync|execFile)\(\s*["'](?:bash|sh)["'][\s\S]{0,500}/g;
  for (const match of source.matchAll(re)) {
    if (!match[0].includes("guardEnv")) hits.push(`${file}: bash`);
  }
  return hits;
}

function unguarded(): string[] {
  const files: string[] = [];
  listTests(ROOT, files);
  const hits: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    hits.push(...nodeMiss(source, file), ...bashMiss(source, file));
  }
  return hits;
}

it("每個會派 node 或 bash 子程序的測試都帶上 guard-real-kill", () => {
  expect(unguarded()).toEqual([]);
});

it("guardedNodeArgs 與 guardEnv 一定預載 guard-real-kill", async () => {
  const mod = await import("./guard-node.ts");
  expect(mod.guardedNodeArgs(["-e", "0"]).slice(0, 2)).toEqual(["--require", GUARD]);
  const env = mod.guardEnv({ PATH: "/bin", NODE_OPTIONS: "--trace-exit" });
  expect(env.NODE_OPTIONS).toContain(`--require ${GUARD}`);
  expect(env.NODE_OPTIONS).toContain("--trace-exit");
  expect(mod.guardEnv({ NODE_OPTIONS: `--require ${GUARD}` }).NODE_OPTIONS).toBe(`--require ${GUARD}`);
});
