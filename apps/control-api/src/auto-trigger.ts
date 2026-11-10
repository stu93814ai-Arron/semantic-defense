import type { Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import { autoListInTx, type AutoListOpts, type AutoListResult } from "./auto-blacklist.js";

/**
 * 成案流程 commit 9：E3.A 自動上榜條件（計畫 §1 步驟 4、§6.1；A 組領航員裁定 11-09）。
 * - 計數只看 case_hits（命中明細不掛在案上；白名單 IP 也照存），有案與白名單無案兩條路徑共用 countHighSeverity。
 * - 高嚴重命中＝ontime_confidence ≥ auto；30 分鐘以 window_start 對比伺服器 now；只計 token 未撤銷且 app 仍綁定者。
 * - 成立：≥3 次，且 ≥2 個不同 app_id 或 sensor_id。
 * - 「3 次」＝3 筆 case_hits 列（sensor × app × 5 分鐘窗），刻意如此：同一個窗裡來自不同來源的 3 列也算 3 次，
 *   因為「≥2 個不同的已綁定來源」本身已要求多來源互相佐證（A 覆核）。
 * - 30 分鐘窗以 window_start（事件時間）對比伺服器 now：若 tick 積壓、晚處理，舊窗的命中會掉出窗外而不計，
 *   結果是案件留在待審（fail safe，不會因積壓而自動上榜）。
 */
export const E3A_WINDOW_MS = 30 * 60_000;
export type HighCount = { hits: number; apps: number; sensors: number };

export async function countHighSeverity(q: Queryable, ip: string, auto: number, now: number): Promise<HighCount> {
  const r = await q.query<{ hits: string; apps: string; sensors: string }>(
    `SELECT count(*) AS hits, count(DISTINCT h.app_id) AS apps, count(DISTINCT h.sensor_id) AS sensors
     FROM case_hits h JOIN sensor_tokens st ON st.sensor_id = h.sensor_id
       AND st.revoked_at IS NULL AND h.app_id = ANY(st.allowed_app_ids)
     WHERE h.src_ip = $1 AND h.ontime_confidence >= $2 AND h.window_start > $3`, [ip, auto, now - E3A_WINDOW_MS]);
  const row = r.rows[0]!;
  return { hits: Number(row.hits), apps: Number(row.apps), sensors: Number(row.sensors) };
}

export const e3aHolds = (c: HighCount): boolean => c.hits >= 3 && (c.apps >= 2 || c.sensors >= 2);

export type Suppressed = { reason: "allowlist" | "cooldown" | "breaker" | "non_public"; ip: string; case_id: string | null; revoked_at?: string };

/** auto_suppressed 去重視窗：同一 (ip, reason) 在這段時間內（伺服器時間）最多一筆（A 覆核，比照 R5 hit_while_listed）。 */
export const AUTO_SUPPRESSED_EVERY_MS = 60 * 60_000;

/**
 * E3.A 成立但被擋下：blacklist.auto_suppressed（actor system:auto、sensor_id null；A 組領航員裁定 11-09 Q4）。
 * 寫前在同一 tx 查 audit_events 過去 1 小時有沒有同 (ip, reason)（partial index audit_auto_suppressed_ip_reason）；
 * 有 → 不寫、回 false（呼叫端計數，tick 結束記一行只帶數量的 log）。寫了回 true。
 */
export async function writeSuppressed(q: Queryable, detail: Suppressed, now: number): Promise<boolean> {
  const dup = await q.query(
    `SELECT 1 FROM audit_events WHERE action = 'blacklist.auto_suppressed'
       AND detail->>'ip' = $1 AND detail->>'reason' = $2 AND at > $3 LIMIT 1`, [detail.ip, detail.reason, now - AUTO_SUPPRESSED_EVERY_MS]);
  if (dup.rows.length > 0) return false;
  await writeAudit(q, { action: "blacklist.auto_suppressed", actor: "system:auto", sensor_id: null, at: now, detail });
  return true;
}

const suppressedOf = (r: AutoListResult, ip: string, case_id: string): Suppressed | null => {
  if (r.status === "allowlisted") return { reason: "allowlist", ip, case_id };
  if (r.status === "breaker") return { reason: "breaker", ip, case_id };
  if (r.status === "not_public") return { reason: "non_public", ip, case_id };
  if (r.status === "cooldown") return { reason: "cooldown", ip, case_id, revoked_at: new Date(r.revoked_at).toISOString() };
  return null;
}

/**
 * 有案路徑：E3.A 成立 → 以該 IP 的 open case 呼叫 autoListInTx（白名單在其中以 SHARE 鎖重查）。
 * gates 開（冷卻／熔斷）。listed → case 改 auto_listed（resolved_by system:auto）；
 * not_public／allowlisted／cooldown／breaker → auto_suppressed{non_public | allowlist | cooldown(+revoked_at) | breaker}，case 維持 open；
 * below_auto_threshold／already_listed → 留在待審、不寫稽核。confidence 用 case 的 max_confidence（Q3）。
 * 回 true＝這次的 auto_suppressed 因 1 小時去重沒寫（tick 計數用）。
 */
export async function autoListCase(q: Queryable, ip: string, now: number, opts: AutoListOpts): Promise<boolean> {
  const c = (await q.query<{ case_id: string; max_confidence: number }>(
    "SELECT case_id, max_confidence FROM blacklist_cases WHERE ip = $1 AND state = 'open' AND expires_at > $2", [ip, now])).rows[0];
  if (!c) return false;
  const r = await autoListInTx(q, { ip, confidence: c.max_confidence, case_id: c.case_id }, now, opts);
  if (r.status === "listed") {
    await q.query("UPDATE blacklist_cases SET state = 'auto_listed', resolved_by = 'system:auto', resolved_at = $2 WHERE case_id = $1",
      [c.case_id, now]);
    return false;
  }
  const s = suppressedOf(r, ip, c.case_id);
  return s !== null && !(await writeSuppressed(q, s, now));
}
