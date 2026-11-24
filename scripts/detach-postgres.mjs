import { createRequire } from "node:module";
import { spawnDetachedPostmaster } from "./pg-lifecycle.mjs";

// 必須在任何 ESM import { spawn } 之前改掉 child_process.spawn。
// with-pg 把這個檔放在第一個 import，embedded-postgres 之後才會用到脫離程序群組的 postgres。
const cp = createRequire(import.meta.url)("node:child_process");
cp.spawn = spawnDetachedPostmaster(cp.spawn);
