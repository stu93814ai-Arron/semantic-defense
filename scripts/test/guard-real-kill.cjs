"use strict";

const real = process.kill;

function addPid(allow, pid) {
  if (Number.isInteger(pid) && Math.abs(pid) > 1) allow.add(pid);
}

function allowList() {
  const allow = new Set();
  for (const part of String(process.env.SD_KILL_ALLOW ?? "").split(",")) {
    const item = part.trim();
    if (item === "self") allow.add(process.pid);
    else if (/^-?\d+$/.test(item)) addPid(allow, Number(item));
  }
  return allow;
}

const allow = allowList();

function permitted(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && allow.has(n);
}

function guardRealKill(pid, signal) {
  if (signal === 0 || signal === "0") return real.call(process, pid, 0);
  if (permitted(pid)) return real.call(process, pid, signal);
  const name = signal === undefined ? "SIGTERM" : String(signal);
  throw new Error(`refusing ${name} to ${String(pid)}`);
}

process.kill = guardRealKill;
