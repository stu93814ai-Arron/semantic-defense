import { spawnSync } from "node:child_process";

/** 目前與 with-pg 相同：spawnSync 會停住事件迴圈。測試預期改成可排空 stderr 的寫法。 */
export function runChild(cmd, args, env) {
  const status = spawnSync(cmd, args, { stdio: "inherit", env }).status ?? 1;
  return Promise.resolve(status);
}
