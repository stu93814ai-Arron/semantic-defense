import type { Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import type { WarnLog } from "./thresholds.js";

/**
 * 成案流程 commit 11：自動上榜熔斷（計畫 §6.3；A 裁定 11-09 第 5 點）。
 * - 全域、滑動 1 小時：source=auto 且 created_at 在窗內的筆數 ≥ N → 熔斷（第 N+1 筆起擋，一小時最多 N 筆）。
 * - 所有自動寫入都在 AUTO_LOCK（xact advisory lock）下序列化，count 才正確；不擋人工撤回與讀取。
 * - auto_breaker 單列只記開關（opened_at），用來判斷「轉換」：只在開→關、關→開時寫稽核＋log.warn（只帶數量）。
 * - 恢復：過窗自動恢復；autoListInTx 每次嘗試、以及 tick 在熔斷開著時，都在 AUTO_LOCK 下重判。
 */
export const AUTO_LOCK = 872_364_204;
export const AUTO_BREAKER_WINDOW_MS = 60 * 60_000;
export const AUTO_BREAKER_PER_HOUR = 50;

/** 白名單 SHARE 鎖（擋並行新增／修改白名單，持有到 tx 結束）。鎖順序見 auto-blacklist.ts：一律先 SHARE 再 AUTO_LOCK。 */
export const lockAllowlistShare = async (q: Queryable): Promise<void> => {
  await q.query("LOCK TABLE allowlist_entries IN SHARE MODE");
};

export const lockAuto = async (q: Queryable): Promise<void> => {
  await q.query("SELECT pg_advisory_xact_lock($1)", [AUTO_LOCK]);
};

const openedAt = async (q: Queryable): Promise<string | null> =>
  (await q.query<{ opened_at: string | null }>("SELECT opened_at FROM auto_breaker WHERE id")).rows[0]?.opened_at ?? null;

/** 呼叫端須已持有 AUTO_LOCK。依目前窗內筆數更新開關（只在轉換時寫稽核），回是否熔斷中。 */
export async function breakerTripped(q: Queryable, limit: number, now: number, log?: WarnLog): Promise<boolean> {
  const r = await q.query<{ n: string }>(
    "SELECT count(*) AS n FROM blocklist_entries WHERE source = 'auto' AND created_at > $1", [now - AUTO_BREAKER_WINDOW_MS]);
  const count = Number(r.rows[0]!.n);
  const tripped = count >= limit;
  const wasOpen = (await openedAt(q)) !== null;
  if (tripped === wasOpen) return tripped;
  await q.query("UPDATE auto_breaker SET opened_at = $1 WHERE id", [tripped ? now : null]);
  const action = tripped ? "blacklist.auto_breaker_open" : "blacklist.auto_breaker_close";
  const detail = tripped ? { count, limit, window_ms: AUTO_BREAKER_WINDOW_MS } : { count, limit };
  await writeAudit(q, { action, actor: "system:auto", sensor_id: null, at: now, detail });
  log?.warn({ count, limit }, tripped ? "auto-list breaker opened" : "auto-list breaker closed");
  return tripped;
}

/** tick 用：熔斷開著才重判（過窗 → 關並寫 close）；關著不拿鎖。照全域鎖順序先拿 SHARE 再拿 AUTO_LOCK。 */
export async function recoverBreakerIfOpen(q: Queryable, limit: number, now: number, log?: WarnLog): Promise<void> {
  if ((await openedAt(q)) === null) return;
  await lockAllowlistShare(q);
  await lockAuto(q);
  await breakerTripped(q, limit, now, log);
}
