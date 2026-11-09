import type { Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import { autoListInTx, type AutoListOpts } from "./auto-blacklist.js";

/**
 * 成案流程 commit 9：E3.A 自動上榜條件（計畫 §1 步驟 4、§6.1；A 裁定 11-09）。
 * - 計數只看 case_hits（命中明細不掛在案上；白名單 IP 也照存），有案與白名單無案兩條路徑共用 countHighSeverity。
 * - 高嚴重命中＝ontime_confidence ≥ auto；30 分鐘以 window_start 對比伺服器 now；只計 token 未撤銷且 app 仍綁定者。
 * - 成立：≥3 次，且 ≥2 個不同 app_id 或 sensor_id。
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

export type Suppressed = { reason: "allowlist" | "cooldown" | "breaker"; ip: string; case_id: string | null; revoked_at?: string };

/** E3.A 成立但被擋下：blacklist.auto_suppressed（actor system:auto、sensor_id null；A 裁定 11-09 Q4）。 */
export async function writeSuppressed(q: Queryable, detail: Suppressed, now: number): Promise<void> {
  await writeAudit(q, { action: "blacklist.auto_suppressed", actor: "system:auto", sensor_id: null, at: now, detail });
}

/**
 * 有案路徑：E3.A 成立 → 以該 IP 的 open case 呼叫 autoListInTx（白名單在其中以 SHARE 鎖重查）。
 * listed → case 改 auto_listed（resolved_by system:auto）；allowlisted → auto_suppressed{allowlist}，case 維持 open；
 * below_auto_threshold／already_listed → 留在待審、不寫稽核。confidence 用 case 的 max_confidence（Q3）。
 */
export async function autoListCase(q: Queryable, ip: string, now: number, opts: AutoListOpts): Promise<void> {
  const c = (await q.query<{ case_id: string; max_confidence: number }>(
    "SELECT case_id, max_confidence FROM blacklist_cases WHERE ip = $1 AND state = 'open' AND expires_at > $2", [ip, now])).rows[0];
  if (!c) return;
  const r = await autoListInTx(q, { ip, confidence: c.max_confidence, case_id: c.case_id }, now, opts);
  if (r.status === "listed") {
    await q.query("UPDATE blacklist_cases SET state = 'auto_listed', resolved_by = 'system:auto', resolved_at = $2 WHERE case_id = $1",
      [c.case_id, now]);
  } else if (r.status === "allowlisted") {
    await writeSuppressed(q, { reason: "allowlist", ip, case_id: c.case_id }, now);
  }
}
