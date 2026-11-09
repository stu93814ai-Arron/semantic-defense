import type { Db } from "../../src/db.js";
import type { WarnLog } from "../../src/thresholds.js";
import { autoListInTx, hostCidr, type AutoListInput, type AutoListResult } from "../../src/auto-blacklist.js";

/**
 * §7 原行為的外層包裝：自己開 tx、不帶 gates（無冷卻／熔斷）。只給測試用（R17）：
 * 產品碼只經判定 tick 的 autoListInTx 上榜，testing-only.test.ts 鎖住 src 不得引用本函式。
 */
export async function writeAutoBlocklistEntry(
  db: Db, input: AutoListInput, now: number, log?: WarnLog,
): Promise<AutoListResult> {
  if (hostCidr(input.ip) === null) return { status: "invalid_ip" };
  return db.tx((q) => autoListInTx(q, input, now, { log }));
}
