import { FLOW_WINDOW_MS, judgeFlows, type FlowMetadataEvent, type FlowThresholds } from "@semantic-defense/contracts";
import { RETENTION_MS, flowEventsReady, type FlowEventRow } from "@semantic-defense/flow-store/read";
import type { Db, Queryable } from "./db.js";
import { loadThresholds, type WarnLog } from "./thresholds.js";
import { accumulateCase, raiseCaseMax, upsertCaseHit } from "./cases.js";
import { allowlisted, hostCidr } from "./auto-blacklist.js";
import { writeAudit } from "./audit.js";

/**
 * 成案流程 commit 7：判定 tick（計畫 §1／§2）。讀 flow_events → 依 (sensor, app, src_ip, 5 分鐘窗) 分組重算 → 命中 → 待審。
 * - 整個 tick 在同一個 Db.tx；pg_try_advisory_xact_lock(JUDGE_LOCK) 拿不到 → 別的實例在跑，直接 no-op。
 * - flow_events 不存在（sensor-ingest 尚未建表）→ no-op；管理面不建表。
 * - 掃描：新列 received_at ∈ (cursor, now]，每批上限 JUDGE_BATCH（滿批時 cursor 只推到該批最後一列）；
 *   另掃 (cursor − 60s, cursor] 的重疊，涵蓋接收時間較早但較晚 commit 的列。
 * - 每組從 flow_events 重讀整組再算：confidence 用全部 flow；ontime_confidence 只用準時 flow（全部遲到 → NULL）。
 *   遲到＝received_at − ts > 5 分鐘。confidence ≥ case 才存命中（case_hits 絕對值 upsert，重掃冪等）；
 *   命中第一次寫入時才累加待審（hit_count +1、max 取大），所以重掃不會重複累加；
 *   重掃（命中已存在）只以 GREATEST 拉高 open 待審的 max（raiseCaseMax）。
 * - 門檻走 loadThresholds（fail-closed）並帶 tick 的 logger：列值不合上下限時 log.warn。
 * - 清除：case_hits 最後更新滿 7 天；已結案 case 的 resolved_at 滿 7 天（計畫 Q18）。
 * 命中存好後（計畫 §1）：白名單內 → 不開案、不寫稽核（Q13）；已上榜 → 只寫 hit_while_listed（Q16）；否則開案／累加。
 * E3.A 自動上榜（commit 9–11）不在本檔這一步。
 */
export const JUDGE_LOCK = 872_364_203;
export const JUDGE_OVERLAP_MS = 60_000;
export const JUDGE_BATCH = 5000;
export const LATE_MS = 5 * 60_000;
export type TickResult = { ran: boolean; groups: number; hits: number };
const NOOP: TickResult = { ran: false, groups: 0, hits: 0 };

type GroupKey = { sensor_id: string; app_id: string; src_ip: string; win: number };
type ScanRow = Pick<FlowEventRow, "sensor_id" | "app_id" | "src_ip" | "ts" | "received_at">;

async function scanGroups(q: Queryable, cursor: number, now: number): Promise<{ keys: GroupKey[]; upto: number }> {
  const fresh = (await q.query<ScanRow>(
    `SELECT sensor_id, app_id, src_ip, ts, received_at FROM flow_events
     WHERE received_at > $1 AND received_at <= $2 ORDER BY received_at LIMIT ${JUDGE_BATCH}`, [cursor, now])).rows;
  const overlap = (await q.query<ScanRow>(
    `SELECT DISTINCT sensor_id, app_id, src_ip, ts, '0' AS received_at FROM flow_events
     WHERE received_at > $1 AND received_at <= $2`, [cursor - JUDGE_OVERLAP_MS, cursor])).rows;
  const keys = new Map<string, GroupKey>();
  for (const r of [...overlap, ...fresh]) {
    const win = Math.floor(Date.parse(r.ts) / FLOW_WINDOW_MS) * FLOW_WINDOW_MS;
    keys.set(JSON.stringify([r.sensor_id, r.app_id, r.src_ip, win]), { sensor_id: r.sensor_id, app_id: r.app_id, src_ip: r.src_ip, win });
  }
  return { keys: [...keys.values()], upto: fresh.length === JUDGE_BATCH ? Number(fresh.at(-1)!.received_at) : now };
}

const toFlow = (r: FlowEventRow): FlowMetadataEvent => ({
  flow_id: r.flow_id, app_id: r.app_id, ts: r.ts, src_ip: r.src_ip, dst_ip: r.dst_ip, src_port: r.src_port,
  dst_port: r.dst_port, protocol: r.protocol as FlowMetadataEvent["protocol"], bytes_in: Number(r.bytes_in),
  bytes_out: Number(r.bytes_out), packets: Number(r.packets), duration_ms: Number(r.duration_ms),
});

/**
 * 已上榜（canonical IP 完全相等、ended_at／revoked_at 為 NULL、expires_at > now）→ 不開案、不延長；
 * 命中第一次寫入時寫一筆 blacklist.hit_while_listed（重掃不重寫）。回是否已上榜。
 */
async function onActiveBlocklist(q: Queryable, k: GroupKey, confidence: number, created: boolean, now: number): Promise<boolean> {
  const ip = hostCidr(k.src_ip)!;
  const r = await q.query<{ entry_id: string }>(
    `SELECT entry_id FROM blocklist_entries
     WHERE ip = $1 AND ended_at IS NULL AND revoked_at IS NULL AND expires_at > $2`, [ip, now]);
  const entry = r.rows[0];
  if (!entry) return false;
  if (created) {
    await writeAudit(q, { action: "blacklist.hit_while_listed", actor: "system:auto", sensor_id: k.sensor_id, at: now,
      detail: { ip, entry_id: entry.entry_id, app_id: k.app_id, window_start: new Date(k.win).toISOString(), confidence } });
  }
  return true;
}

/** 重讀整組並判定；confidence ≥ case → 存命中（第一次寫入時累加待審），回 true。 */
async function judgeGroup(q: Queryable, k: GroupKey, th: FlowThresholds, now: number): Promise<boolean> {
  const rows = (await q.query<FlowEventRow>(
    `SELECT * FROM flow_events WHERE sensor_id = $1 AND app_id = $2 AND src_ip = $3
       AND ts::timestamptz >= to_timestamp($4 / 1000.0) AND ts::timestamptz < to_timestamp($5 / 1000.0)`,
    [k.sensor_id, k.app_id, k.src_ip, k.win, k.win + FLOW_WINDOW_MS])).rows;
  const all = judgeFlows(rows.map(toFlow), th)[0];
  if (!all?.open_case) return false;
  const ontime = rows.filter((r) => Number(r.received_at) - Date.parse(r.ts) <= LATE_MS).map(toFlow);
  const ontimeConfidence = ontime.length > 0 ? judgeFlows(ontime, th)[0]!.confidence : null;
  const { created } = await upsertCaseHit(q, { src_ip: k.src_ip, sensor_id: k.sensor_id, app_id: k.app_id,
    window_start: k.win, confidence: all.confidence, ontime_confidence: ontimeConfidence }, now);
  if (await allowlisted(q, k.src_ip, now)) return true;
  if (await onActiveBlocklist(q, k, all.confidence, created, now)) return true;
  if (created) await accumulateCase(q, { ip: k.src_ip, confidence: all.confidence, late: ontime.length < rows.length }, now);
  else await raiseCaseMax(q, k.src_ip, all.confidence, now);
  return true;
}

export async function runJudgeTick(db: Db, now: number, log?: WarnLog): Promise<TickResult> {
  if (!(await flowEventsReady(db))) return NOOP;
  return db.tx(async (q): Promise<TickResult> => {
    const lock = await q.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [JUDGE_LOCK]);
    if (lock.rows[0]?.ok !== true) return NOOP;
    const th = await loadThresholds(q, log);
    const cur = (await q.query<{ received_upto: string }>("SELECT received_upto FROM judge_cursor WHERE id")).rows[0];
    const { keys, upto } = await scanGroups(q, Number(cur?.received_upto ?? 0), now);
    let hits = 0;
    for (const k of keys) if (await judgeGroup(q, k, th, now)) hits += 1;
    await q.query("DELETE FROM case_hits WHERE updated_at <= $1", [now - RETENTION_MS]);
    await q.query("DELETE FROM blacklist_cases WHERE state <> 'open' AND resolved_at <= $1", [now - RETENTION_MS]);
    await q.query(
      `INSERT INTO judge_cursor (id, received_upto) VALUES (TRUE, $1)
       ON CONFLICT (id) DO UPDATE SET received_upto = GREATEST(judge_cursor.received_upto, EXCLUDED.received_upto)`, [upto]);
    return { ran: true, groups: keys.length, hits };
  });
}
