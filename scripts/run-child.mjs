import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
let active = null;

/** with-pg 收到 SIGTERM 時要等這位子行程先把快照寫完。 */
export function currentChild() { return active; }

/**
 * 跑 with-pg 的子行程，並把事件迴圈讓出來。
 * spawnSync 會停住 with-pg 的 libuv loop，Postgres stderr 沒人讀；
 * 管道一滿，後端寫 ERROR/STATEMENT 就停在 write()，交易與 advisory lock 一直留到外層 timeout。
 */
export function runChild(cmd, args, env) {
  return new Promise((resolve) => {
    const { spawn } = nodeRequire("node:child_process");
    const child = spawn(cmd, args, { stdio: "inherit", env });
    active = child;
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}
