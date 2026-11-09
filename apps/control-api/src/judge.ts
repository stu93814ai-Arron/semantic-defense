import { FLOW_WINDOW_MS, judgeFlows, type FlowMetadataEvent, type FlowThresholds } from "@semantic-defense/contracts";
import { RETENTION_MS, flowEventsReady, type FlowEventRow } from "@semantic-defense/flow-store/read";
import type { Db, Queryable } from "./db.js";
import { loadThresholds, type WarnLog } from "./thresholds.js";
import { accumulateCase, expireOpenCases, raiseCaseMax, upsertCaseHit } from "./cases.js";
import { hostCidr, loadAllowlist } from "./auto-blacklist.js";
import { writeAudit } from "./audit.js";

/**
 * 成案流程 commit 7：判定 tick（計畫 §1／§2）。讀 flow_events → 依 (sensor, app, src_ip, 5 分鐘窗) 分組重算 → 命中 → 待審。
 * - 整個 tick 在同一個 Db.tx；pg_try_advisory_xact_lock(JUDGE_LOCK) 拿不到 → 別的實例在跑，直接 no-op。
 * - flow_events 不存在（sensor-ingest 尚未建表）→ no-op；管理面不建表。
 * - 掃描：新列 received_at ∈ (cursor, now]，每批上限 JUDGE_BATCH；cursor 只推到這批實際看到的最大 received_at
 *   （received_at 是 sensor-ingest 的時鐘，不能跳到 control-api 的 now）；沒有新列就不動。
 *   另掃 (cursor − 60s, cursor] 的重疊，涵蓋接收時間較早但較晚 commit 的列。
 * - 每組從 flow_events 重讀整組再算：confidence 用全部 flow；ontime_confidence 只用準時 flow（全部遲到 → NULL）。
 *   遲到＝received_at − ts > 5 分鐘。confidence ≥ case 才存命中（case_hits 絕對值 upsert，重掃冪等）；
 *   命中第一次寫入時才累加待審（hit_count +1、max 取大），所以重掃不會重複累加；
 *   重掃（命中已存在）只以 GREATEST 拉高 open 待審的 max（raiseCaseMax）。
 * - 門檻走 loadThresholds（fail-closed）並帶 tick 的 logger：列值不合上下限時 log.warn。
 * - 每次開始先把所有已到期的 open case 收成 expired（resolved_at = expires_at），不必等同 IP 再命中。
 * - 清除：case_hits 第一次寫入（first_seen_at）滿 7 天；已結案 case 的 resolved_at 滿 7 天（計畫 Q18）。
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
/** 分組鍵欄位（窗由 ts 算，與 judgeFlows 同用 Date.parse）；新列另帶 received_at 推 cursor。 */
type KeyRow = Pick<FlowEventRow, "sensor_id" | "app_id" | "src_ip" | "ts">;
type ScanRow = KeyRow & Pick<FlowEventRow, "received_at">;
/** 一個 tick 內共用：門檻、白名單判斷（每個 tick 只讀一次）、時間、本 tick 計數（被去重的 hit_while_listed）。 */
type TickCtx = { th: FlowThresholds; isAllowlisted: (ip: string) => boolean; now: number; stats: { suppressed: number } };

/** upto：這批實際看到的最大 received_at（沒有新列 → null，cursor 不動）。不用 control-api 的 now，ingest 時鐘較慢時才不會漏列。 */
async function scanGroups(q: Queryable, cursor: number, now: number): Promise<{ keys: GroupKey[]; upto: number | null }> {
  const fresh = (await q.query<ScanRow>(
    `SELECT sensor_id, app_id, src_ip, ts, received_at FROM flow_events
     WHERE received_at > $1 AND received_at <= $2 ORDER BY received_at LIMIT ${JUDGE_BATCH}`, [cursor, now])).rows;
  const overlap = (await q.query<KeyRow>(
    `SELECT sensor_id, app_id, src_ip, ts FROM flow_events
     WHERE received_at > $1 AND received_at <= $2`, [cursor - JUDGE_OVERLAP_MS, cursor])).rows;
  const keys = new Map<string, GroupKey>();
  for (const r of [...overlap, ...fresh]) {
    const win = Math.floor(Date.parse(r.ts) / FLOW_WINDOW_MS) * FLOW_WINDOW_MS;
    keys.set(JSON.stringify([r.sensor_id, r.app_id, r.src_ip, win]), { sensor_id: r.sensor_id, app_id: r.app_id, src_ip: r.src_ip, win });
  }
  const last = fresh.at(-1);
  return { keys: [...keys.values()], upto: last ? Number(last.received_at) : null };
}

const toFlow = (r: FlowEventRow): FlowMetadataEvent => ({
  flow_id: r.flow_id, app_id: r.app_id, ts: r.ts, src_ip: r.src_ip, dst_ip: r.dst_ip, src_port: r.src_port,
  dst_port: r.dst_port, protocol: r.protocol as FlowMetadataEvent["protocol"], bytes_in: Number(r.bytes_in),
  bytes_out: Number(r.bytes_out), packets: Number(r.packets), duration_ms: Number(r.duration_ms),
});

/** hit_while_listed 去重視窗：同一 entry_id 在這段時間內（伺服器時間）最多一筆稽核（資安退回 R5）。 */
export const HIT_WHILE_LISTED_EVERY_MS = 60 * 60_000;

/** 去重狀態不另存：直接查 audit_events 本身過去 1 小時有沒有同 entry_id 的 hit_while_listed。 */
async function auditedWithinHour(q: Queryable, entryId: string, now: number): Promise<boolean> {
  const r = await q.query(
    `SELECT 1 FROM audit_events WHERE action = 'blacklist.hit_while_listed' AND detail->>'entry_id' = $1 AND at > $2 LIMIT 1`,
    [entryId, now - HIT_WHILE_LISTED_EVERY_MS]);
  return r.rows.length > 0;
}

/**
 * 已上榜（canonical IP 完全相等、ended_at／revoked_at 為 NULL、expires_at > now）→ 不開案、不延長；
 * 命中第一次寫入時寫一筆 blacklist.hit_while_listed（重掃不重寫），同一 entry_id 每小時最多一筆，
 * 多出來的計入 stats.suppressed（tick 結束記一行 log）。回是否已上榜。
 */
async function onActiveBlocklist(q: Queryable, k: GroupKey, confidence: number, created: boolean, ctx: TickCtx): Promise<boolean> {
  const { now } = ctx;
  const ip = hostCidr(k.src_ip)!;
  const r = await q.query<{ entry_id: string }>(
    `SELECT entry_id FROM blocklist_entries
     WHERE ip = $1 AND ended_at IS NULL AND revoked_at IS NULL AND expires_at > $2`, [ip, now]);
  const entry = r.rows[0];
  if (!entry) return false;
  if (created && (await auditedWithinHour(q, entry.entry_id, now))) ctx.stats.suppressed += 1;
  else if (created) {
    await writeAudit(q, { action: "blacklist.hit_while_listed", actor: "system:auto", sensor_id: k.sensor_id, at: now,
      detail: { ip, entry_id: entry.entry_id, app_id: k.app_id, window_start: new Date(k.win).toISOString(), confidence } });
  }
  return true;
}

/**
 * 重讀整組並判定；confidence ≥ case → 存命中（第一次寫入時累加待審），回 "hit"。
 * src_ip 不是可上榜的主機位址（hostCidr 拒收：127/8、0.0.0.0、多播、link-local、::1、廣播…）→ 整組跳過回 "skipped"，
 * 否則 upsertCaseHit 拋錯會讓整個 tick rollback、cursor 永遠卡住（資安退回 B1）。
 */
async function judgeGroup(q: Queryable, k: GroupKey, ctx: TickCtx): Promise<"hit" | "miss" | "skipped"> {
  const { th, isAllowlisted, now } = ctx;
  if (hostCidr(k.src_ip) === null) return "skipped";
  const rows = (await q.query<FlowEventRow>(
    `SELECT * FROM flow_events WHERE sensor_id = $1 AND app_id = $2 AND src_ip = $3
       AND ts::timestamptz >= to_timestamp($4 / 1000.0) AND ts::timestamptz < to_timestamp($5 / 1000.0)`,
    [k.sensor_id, k.app_id, k.src_ip, k.win, k.win + FLOW_WINDOW_MS])).rows;
  const all = judgeFlows(rows.map(toFlow), th)[0];
  if (!all?.open_case) return "miss";
  const ontime = rows.filter((r) => Number(r.received_at) - Date.parse(r.ts) <= LATE_MS).map(toFlow);
  const ontimeConfidence = ontime.length > 0 ? judgeFlows(ontime, th)[0]!.confidence : null;
  const { created } = await upsertCaseHit(q, { src_ip: k.src_ip, sensor_id: k.sensor_id, app_id: k.app_id,
    window_start: k.win, confidence: all.confidence, ontime_confidence: ontimeConfidence }, now);
  if (isAllowlisted(k.src_ip)) return "hit";
  if (await onActiveBlocklist(q, k, all.confidence, created, ctx)) return "hit";
  if (created) await accumulateCase(q, { ip: k.src_ip, confidence: all.confidence, late: ontime.length < rows.length }, now);
  else await raiseCaseMax(q, k.src_ip, all.confidence, now);
  return "hit";
}

/**
 * 每組一個 SAVEPOINT（資安退回 B2）：感測器送來 Postgres 不收的 ts（0000 年、offset ±23:59…）會讓 ts::timestamptz 拋錯；
 * 失敗只 ROLLBACK TO SAVEPOINT 這一組（外層 tx 回到可用狀態），計入 failed，其他組照常、tick 照常 commit、cursor 照常前進。
 */
async function judgeGroupIsolated(q: Queryable, k: GroupKey, ctx: TickCtx): Promise<"hit" | "miss" | "skipped" | "failed"> {
  await q.query("SAVEPOINT judge_group");
  try {
    const r = await judgeGroup(q, k, ctx);
    await q.query("RELEASE SAVEPOINT judge_group");
    return r;
  } catch {
    await q.query("ROLLBACK TO SAVEPOINT judge_group");
    return "failed";
  }
}

/** 每個 tick 各一行，只記數量、不記 IP／ts：跳過的非主機位址組（B1）、失敗回滾的組（B2）、被去重的 hit_while_listed（R5）。 */
function logTickCounts(log: WarnLog | undefined, n: { skipped: number; failed: number }, suppressed: number): void {
  if (n.skipped > 0) log?.warn({ skipped: n.skipped }, "judge tick skipped non-host src_ip groups");
  if (n.failed > 0) log?.warn({ failed: n.failed }, "judge tick rolled back failed groups");
  if (suppressed > 0) log?.warn({ suppressed }, "judge tick suppressed hit_while_listed audits (1 per entry per hour)");
}

export async function runJudgeTick(db: Db, now: number, log?: WarnLog): Promise<TickResult> {
  if (!(await flowEventsReady(db))) return NOOP;
  return db.tx(async (q): Promise<TickResult> => {
    const lock = await q.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [JUDGE_LOCK]);
    if (lock.rows[0]?.ok !== true) return NOOP;
    const th = await loadThresholds(q, log);
    await expireOpenCases(q, now);
    const cur = (await q.query<{ received_upto: string }>("SELECT received_upto FROM judge_cursor WHERE id")).rows[0];
    const { keys, upto } = await scanGroups(q, Number(cur?.received_upto ?? 0), now);
    const ctx: TickCtx = { th, isAllowlisted: await loadAllowlist(q, now), now, stats: { suppressed: 0 } };
    const n = { hit: 0, miss: 0, skipped: 0, failed: 0 };
    for (const k of keys) n[await judgeGroupIsolated(q, k, ctx)] += 1;
    logTickCounts(log, n, ctx.stats.suppressed);
    // 依 first_seen_at（第一次寫入、伺服器時間）清：重掃會一直刷新 updated_at，用它清會永遠清不掉（資安退回 R3）
    await q.query("DELETE FROM case_hits WHERE first_seen_at <= $1", [now - RETENTION_MS]);
    await q.query("DELETE FROM blacklist_cases WHERE state <> 'open' AND resolved_at <= $1", [now - RETENTION_MS]);
    if (upto !== null) {
      await q.query(
        `INSERT INTO judge_cursor (id, received_upto) VALUES (TRUE, $1)
         ON CONFLICT (id) DO UPDATE SET received_upto = GREATEST(judge_cursor.received_upto, EXCLUDED.received_upto)`, [upto]);
    }
    return { ran: true, groups: keys.length, hits: n.hit };
  });
}
