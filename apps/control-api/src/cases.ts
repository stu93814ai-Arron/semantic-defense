import { randomUUID } from "node:crypto";
import type { Queryable } from "./db.js";
import { hostCidr } from "./auto-blacklist.js";

/**
 * 成案流程 commit 6：待審（blacklist_cases）累加與命中明細（case_hits）存放。計畫 §4／§5。
 * - 待審以 ip（canonical /32、/128）去重：同 IP 至多一筆 open；到期＝created_at + 24h，累加不延長。
 * - 累加：同 tx 先 sweep（open 且已到期 → expired、resolved_at = expires_at），再
 *   INSERT … ON CONFLICT (ip) WHERE state='open' DO UPDATE（hit_count+1、max 取大、last_hit_at 取大、has_late OR）。
 *   並行開案由唯一索引序列化：後到者走 DO UPDATE，不會出現兩筆 open。
 * - case_hits 以 (src_ip, sensor_id, app_id, window_start) upsert，值為絕對值（重掃冪等）；created 表示第一次寫入
 *   （＝命中第一次跨過 case 門檻，呼叫端據此決定是否累加）。
 * 本檔不讀 flow_events、不做判定。
 */
export const CASE_TTL_MS = 24 * 60 * 60 * 1000;

export type CaseHitInput = { ip: string; confidence: number; late: boolean };
export type CaseRow = { case_id: string; ip: string; hit_count: number; max_confidence: number; created_at: string; last_hit_at: string };

function canonicalIp(raw: string): string {
  const ip = hostCidr(raw);
  if (ip === null) throw new Error("case ip 必須是 /32 或 /128 主機位址");
  return ip;
}

/** 全面收掉已到期的 open 待審：state='expired'、resolved_at = expires_at（判定 tick 每次開始時呼叫；之後滿 7 天由 tick 清除）。 */
export async function expireOpenCases(q: Queryable, now: number): Promise<void> {
  await q.query("UPDATE blacklist_cases SET state = 'expired', resolved_at = expires_at WHERE state = 'open' AND expires_at <= $1", [now]);
}

export async function accumulateCase(q: Queryable, h: CaseHitInput, now: number): Promise<CaseRow> {
  const ip = canonicalIp(h.ip);
  await q.query(
    "UPDATE blacklist_cases SET state = 'expired', resolved_at = expires_at WHERE ip = $1 AND state = 'open' AND expires_at <= $2",
    [ip, now],
  );
  const r = await q.query<CaseRow>(
    `INSERT INTO blacklist_cases (case_id, ip, state, max_confidence, hit_count, has_late, created_at, expires_at, last_hit_at)
     VALUES ($1, $2, 'open', $3, 1, $4, $5, $6, $5)
     ON CONFLICT (ip) WHERE state = 'open' DO UPDATE SET
       hit_count = blacklist_cases.hit_count + 1,
       max_confidence = GREATEST(blacklist_cases.max_confidence, EXCLUDED.max_confidence),
       last_hit_at = GREATEST(blacklist_cases.last_hit_at, EXCLUDED.last_hit_at),
       has_late = blacklist_cases.has_late OR EXCLUDED.has_late
     RETURNING case_id, ip, hit_count, max_confidence, created_at, last_hit_at`,
    [randomUUID(), ip, h.confidence, h.late, now, now + CASE_TTL_MS],
  );
  return r.rows[0]!;
}

export type CaseHit = {
  src_ip: string; sensor_id: string; app_id: string; window_start: number;
  confidence: number; ontime_confidence: number | null;
};

/** prevOntime：這次寫入前的 ontime_confidence（第一次寫入 → null），供判斷「新的」高嚴重命中。 */
export async function upsertCaseHit(q: Queryable, h: CaseHit, now: number): Promise<{ created: boolean; prevOntime: number | null }> {
  const r = await q.query<{ created: boolean; prev_ontime: number | null }>(
    `WITH prev AS (SELECT ontime_confidence FROM case_hits
       WHERE src_ip = $1 AND sensor_id = $2 AND app_id = $3 AND window_start = $4)
     INSERT INTO case_hits (src_ip, sensor_id, app_id, window_start, confidence, ontime_confidence, first_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (src_ip, sensor_id, app_id, window_start) DO UPDATE SET
       confidence = EXCLUDED.confidence, ontime_confidence = EXCLUDED.ontime_confidence, updated_at = EXCLUDED.updated_at
     RETURNING (xmax = 0) AS created, (SELECT ontime_confidence FROM prev) AS prev_ontime`,
    [canonicalIp(h.src_ip), h.sensor_id, h.app_id, h.window_start, h.confidence, h.ontime_confidence, now],
  );
  return { created: r.rows[0]!.created, prevOntime: r.rows[0]!.prev_ontime };
}

/**
 * 重掃（命中已存在）時只把同 IP 的 open 待審 max_confidence 以 GREATEST 拉高（A 組領航員裁定 11-09）：
 * hit_count 不加、expires_at 不延長、last_hit_at 不動（只在新命中第一次寫入時更新）；不是 open 或已到期就不更新。
 * 已知且接受：case_hits 不記 case_id，只依 IP 找目前 open 的那筆。所以舊命中（屬於已收掉的舊 case）因遲到的 flow
 * 被重掃時，可能拉高同 IP 新 case 的最高分。
 */
export async function raiseCaseMax(q: Queryable, ip: string, confidence: number, now: number): Promise<void> {
  await q.query(
    `UPDATE blacklist_cases SET max_confidence = GREATEST(max_confidence, $2)
     WHERE ip = $1 AND state = 'open' AND expires_at > $3`,
    [canonicalIp(ip), confidence, now],
  );
}
