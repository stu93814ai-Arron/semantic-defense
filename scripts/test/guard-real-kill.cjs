"use strict";

const real = process.kill;
const allowSelf = process.env.SD_KILL_ALLOW === "self";

function isOwnPid(pid) {
  return pid === process.pid && Number.isInteger(pid) && pid > 0;
}

function guardRealKill(pid, signal) {
  if (signal === 0 || signal === "0") return real.call(process, pid, 0);
  if (allowSelf && isOwnPid(pid)) return real.call(process, pid, signal);
  const name = signal === undefined ? "SIGTERM" : String(signal);
  throw new Error(`refusing ${name} to ${String(pid)}`);
}

process.kill = guardRealKill;
