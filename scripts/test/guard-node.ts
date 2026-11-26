import { resolve } from "node:path";

export const GUARD_REAL_KILL = resolve(__dirname, "guard-real-kill.cjs");

export function guardedNodeArgs(args: readonly string[]): string[] {
  return ["--require", GUARD_REAL_KILL, ...args];
}

export function guardEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const flag = `--require ${GUARD_REAL_KILL}`;
  const prev = next.NODE_OPTIONS ?? "";
  if (prev.includes("guard-real-kill.cjs")) return next;
  next.NODE_OPTIONS = prev ? `${prev} ${flag}` : flag;
  return next;
}
