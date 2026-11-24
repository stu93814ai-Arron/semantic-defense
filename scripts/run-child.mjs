import { spawn } from "node:child_process";

/**
 * 跑 with-pg 的子行程，並把事件迴圈讓出來。
 * spawnSync 會停住 with-pg 的 libuv loop，Postgres stderr 沒人讀；
 * 管道一滿，後端寫 ERROR/STATEMENT 就停在 write()，交易與 advisory lock 一直留到外層 timeout。
 */
export function runChild(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env });
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}
