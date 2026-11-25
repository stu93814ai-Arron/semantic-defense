/* eslint-disable security/detect-non-literal-fs-filename -- 目錄是 with-pg 剛建立的暫存路徑 */
import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 只接受大於 1 的十進位整數。0、1、負數、小數、空白都不是 postmaster。 */
export function postmasterPid(text) {
  const line = String(text).split("\n")[0];
  if (!/^[1-9]\d*$/.test(line)) return null;
  const pid = Number(line);
  return pid > 1 ? pid : null;
}

function pointedData(argv) {
  let nextIsData = false;
  for (const arg of argv) {
    if (nextIsData) return arg;
    if (arg === "-D") { nextIsData = true; continue; }
    if (arg.startsWith("-D") && arg.length > 2) return arg.slice(2);
  }
  return "";
}

function isOurPostmaster(pid, dir, cmdline) {
  const raw = cmdline(pid);
  if (!raw) return false;
  const argv = String(raw).split("\0").filter(Boolean);
  const bin = argv[0] ?? "";
  if (bin !== "postgres" && !bin.endsWith("/postgres")) return false;
  const pointed = pointedData(argv);
  return pointed !== "" && resolve(pointed) === resolve(dir, "data");
}

function readPgid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const pgid = Number(rest[2]);
    return Number.isInteger(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

function defaultKill(pid, sig) { process.kill(pid, sig); }

function defaultCmdline(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`); } catch { return null; }
}

function signalVerified(kill, pid, pgid) {
  if (pgid === pid) {
    try { kill(-pid, "SIGKILL"); return; } catch { /* 群組殺不了就只殺已驗證的 pid */ }
  }
  try { kill(pid, "SIGKILL"); } catch { /* 已結束 */ }
}

function killIfOurs(dir, hooks) {
  const pidFile = join(dir, "data", "postmaster.pid");
  if (!existsSync(pidFile)) return;
  const pid = postmasterPid(readFileSync(pidFile, "utf8"));
  if (pid === null) return;
  const cmdline = hooks.cmdline ?? defaultCmdline;
  if (!isOurPostmaster(pid, dir, cmdline)) return;
  const kill = hooks.kill ?? defaultKill;
  const pgidOf = hooks.pgid ?? readPgid;
  signalVerified(kill, pid, pgidOf(pid));
}

function unlinkOwn(dir) {
  try { unlinkSync(dir); } catch { /* 已消失 */ }
}

/** 驗證失敗不殺任何程序。目錄本身是 symlink 時只卸掉連結。 */
export function reapDir(dir, hooks = {}) {
  let st;
  try { st = lstatSync(dir); } catch { return; }
  if (st.isSymbolicLink()) { unlinkOwn(dir); return; }
  if (!st.isDirectory()) return;
  killIfOurs(dir, hooks);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已消失 */ }
}

function parentAlive(parent) {
  try { process.kill(parent, 0); return true; } catch { return false; }
}

function main() {
  const parent = Number(process.argv[2]);
  const dir = process.argv[3];
  if (!parent || !dir) process.exit(0);
  const timer = setInterval(() => {
    if (parentAlive(parent)) return;
    clearInterval(timer);
    reapDir(dir);
    process.exit(0);
  }, 200);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) main();
