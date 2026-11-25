/* eslint-disable security/detect-non-literal-fs-filename -- 目錄是 with-pg 剛建立的暫存路徑 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const parent = Number(process.argv[2]);
const dir = process.argv[3];
if (!parent || !dir) process.exit(0);

function parentAlive() {
  try {
    process.kill(parent, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  try { process.kill(-pid, "SIGKILL"); } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* 已結束 */ }
  }
}

function reap() {
  if (!existsSync(dir)) return;
  const pidFile = join(dir, "data", "postmaster.pid");
  if (existsSync(pidFile)) {
    const pid = Number(String(readFileSync(pidFile, "utf8")).split("\n")[0]);
    if (pid) killPid(pid);
  }
  rmSync(dir, { recursive: true, force: true });
}

const timer = setInterval(() => {
  if (parentAlive()) return;
  clearInterval(timer);
  reap();
  process.exit(0);
}, 200);
