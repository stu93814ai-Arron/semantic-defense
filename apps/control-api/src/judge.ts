import { FLOW_WINDOW_MS, judgeFlows, type FlowMetadataEvent, type FlowThresholds } from "@semantic-defense/contracts";
import { RETENTION_MS, flowEventsReady, type FlowEventRow } from "@semantic-defense/flow-store/read";
import type { Db, Queryable } from "./db.js";
import { loadThresholds } from "./thresholds.js";

/** 判定 tick 的 log：warn 與 error 皆必填（stale_pending 走 error）。 */
export type TickLog = { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
import { accumulateCase, expireOpenCases, raiseCaseMax, upsertCaseHit } from "./cases.js";
import { hostCidr, loadAllowlist } from "./auto-blacklist.js";
import { writeAudit } from "./audit.js";
import { autoListCase, countHighSeverity, e3aHolds, writeSuppressed } from "./auto-trigger.js";
import { AUTO_BREAKER_PER_HOUR, recoverBreakerIfOpen } from "./auto-breaker.js";

/**
 * 成案流程 commit 7：判定 tick（計畫 §1／§2）。讀 flow_events → 依 (sensor, app, src_ip, 5 分鐘窗) 分組重算 → 命中 → 待審。
 * - 整個 tick 在同一個 Db.tx；pg_try_advisory_xact_lock(JUDGE_LOCK) 拿不到 → 別的實例在跑，直接 no-op。
 * - flow_events 不存在（sensor-ingest 尚未建表）→ no-op；管理面不建表。
 * - 掃描：新列 received_at ∈ (cursor, now]，每批上限 JUDGE_BATCH；cursor 只推到這批實際看到的最大 received_at
 *   （received_at 是 sensor-ingest 的時鐘，不能跳到 control-api 的 now）；沒有新列就不動。
 *   另掃 (cursor − 60s, cursor] 的重疊，涵蓋接收時間較早但較晚 commit 的列。
 * - 分窗只用 ts_ms（ts slice）：ts_ms NULL 的列不分組。毒列（flow_ts_ms 亦 NULL）只計數（log {null_ts}），cursor 照常前進。
 *   待回填（可轉換的 NULL）在 lag 上限內 cursor 停在該列之前（{pending_backfill}）；超過上限則略過並計入 {stale_pending}（error）。
 * - 每組從 flow_events 重讀整組再算：confidence 用全部 flow；ontime_confidence 只用準時 flow（全部遲到 → NULL）。
 *   遲到＝received_at − ts_ms > 5 分鐘。confidence ≥ case 才存命中（case_hits 絕對值 upsert，重掃冪等）；
 *   命中第一次寫入時才累加待審（hit_count +1、max 取大），所以重掃不會重複累加；
 *   重掃（命中已存在）只以 GREATEST 拉高 open 待審的 max（raiseCaseMax）。
 * - 門檻走 loadThresholds（fail-closed）並帶 tick 的 logger：列值不合上下限時 log.warn。
 * - 每次開始先把所有已到期的 open case 收成 expired（resolved_at = expires_at），不必等同 IP 再命中。
 * - 清除：case_hits 第一次寫入（first_seen_at）滿 7 天；已結案 case 的 resolved_at 滿 7 天（計畫 Q18）。
 * 命中存好後（計畫 §1）：白名單內 → 不開案、不寫稽核（Q13）；已上榜 → 只寫 hit_while_listed（Q16）；否則開案／累加。
 * 新的高嚴重命中 → E3.A（auto-trigger.ts）：白名單 IP 只寫 auto_suppressed{allowlist}（不開案）；
 * 有案路徑經 autoListInTx 上榜（白名單在其中以 SHARE 鎖重查）。冷卻、熔斷在 autoListInTx 內（gates，tick 才開）；
 * 熔斷開著時 tick 開頭在 AUTO_LOCK 下重判恢復（auto-breaker.ts）。
 */
export const JUDGE_LOCK = 872_364_203;
export const JUDGE_OVERLAP_MS = 60_000;
export const JUDGE_BATCH = 5000;
/**
 * 待回填列可落後「最新 received_at」的上限（10 分鐘）。超過則視為 stale_pending，略過並讓 cursor 前進（與毒列相同）。
 * 基準是表內 max(received_at)（received_at <= now），不是 wall-clock now：首次回填期間歷史列的 received_at
 * 可能已是數小時／數天前，若跟 now 比會全部被當成過期而永久略過，重現 4(b)。跟最新 received_at 比，
 * 才能區分「回填正在追歷史流」（pending 與最新列接近）與「回填已結束後才出現的舊 NULL 卡住較新流量」。
 */
export const PENDING_BACKFILL_MAX_LAG_MS = 10 * 60_000;
export const LATE_MS = 5 * 60_000;
export type TickResult = { ran: boolean; groups: number; hits: number };
const NOOP: TickResult = { ran: false, groups: 0, hits: 0 };

type GroupKey = { sensor_id: string; app_id: string; src_ip: string; win: number };
/**
 * 分組鍵欄位：窗由 ts_ms 算（ingest 以 Date.parse 寫入／啟動時 SQL 同值回填，與 judgeFlows 一致）；新列另帶 received_at 推 cursor。
 * ts_ms NULL：毒列（flow_ts_ms 亦 NULL）不分組、計入 stats.nullTs，cursor 照常前進；
 * 待回填（flow_ts_ms 非 NULL）在 PENDING_BACKFILL_MAX_LAG_MS 內 cursor 停在該列之前，計入 stats.pendingBackfill；
 * 超過上限則略過、計入 stats.stalePending，cursor 前進（B1）。flow_ts_ms 只用於停點，不分組。
 */
type KeyRow = Pick<FlowEventRow, "sensor_id" | "app_id" | "src_ip" | "ts_ms">;
type ScanRow = KeyRow & Pick<FlowEventRow, "received_at"> & { convertible_ms: string | null };
/**
 * runJudgeTick 的測試掛勾。beforeAutoList：時序注入點（讀完白名單之後、autoListInTx 之前）；
 * afterAllowlistShare：autoListInTx 取得 SHARE 之後。只能經 runJudgeTick 第 4 個參數傳入；buildApp 的排程不傳（A 組領航員裁定 11-09）。
 */
export type TickHooks = { beforeAutoList?: () => Promise<void>; afterAllowlistShare?: () => Promise<void> };
/**
 * 自動上榜總開關的預設值（唯一來源）：關。關時 tick 完全不做自動上榜——不評估 E3.A、不判熔斷恢復、
 * 不寫 auto_list／auto_suppressed／auto_breaker_*，案件只留在待審。buildApp 的 autoListEnabled 與測試明確開啟。
 */
export const AUTO_LIST_ENABLED_DEFAULT = false;
/** runJudgeTick 第 4 個參數：掛勾＋熔斷上限 N（buildApp 的 autoBreakerPerHour，預設 50）＋自動上榜總開關。 */
export type TickOpts = TickHooks & { autoBreakerPerHour?: number; autoListEnabled?: boolean };
/** 一個 tick 內共用：門檻、白名單（每個 tick 只讀一次；只決定要不要開案）、時間、log、掛勾、本 tick 計數（去重的 hit_while_listed、failed 的 SQLSTATE）。 */
type TickCtx = { th: FlowThresholds; isAllowlisted: (ip: string) => boolean; now: number; log?: TickLog; hooks: TickHooks; breakerPerHour: number;
  autoList: boolean;
  stats: { suppressed: number; deduped: number; codes: Map<string, number>; nullTs: number; pendingBackfill: number; stalePending: number } };

/** 待回填：ts_ms 仍 NULL 但 flow_ts_ms(ts) 算得出值。只用來決定 cursor 停點，絕不用來分組。 */
const isPendingBackfill = (r: ScanRow): boolean => r.ts_ms === null && r.convertible_ms != null;
/** 待回填且落後 newest received_at 超過上限：略過，不再卡住 cursor。 */
const isStalePending = (r: ScanRow, newestAt: number): boolean =>
  isPendingBackfill(r) && newestAt - Number(r.received_at) > PENDING_BACKFILL_MAX_LAG_MS;

type PendingSplit = { stopAt: number; pendingAt: number | null; pendingBackfill: number; stalePending: number };

/** 依 lag 上限拆待回填列：上限內停 cursor；超過的計入 stalePending（已略過），cursor 可越過。 */
function splitPending(fresh: ScanRow[], newestAt: number): PendingSplit {
  const out: PendingSplit = { stopAt: -1, pendingAt: null, pendingBackfill: 0, stalePending: 0 };
  for (const [i, r] of fresh.entries()) {
    if (!isPendingBackfill(r)) continue;
    if (out.pendingAt !== null) {
      if (!isStalePending(r, newestAt)) out.pendingBackfill += 1;
      continue;
    }
    if (isStalePending(r, newestAt)) { out.stalePending += 1; continue; }
    out.stopAt = i;
    out.pendingAt = Number(r.received_at);
    out.pendingBackfill += 1;
  }
  return out;
}

async function newestReceivedAt(q: Queryable, now: number): Promise<number> {
  const r = await q.query<{ max: string | null }>(
    "SELECT max(received_at) AS max FROM flow_events WHERE received_at <= $1", [now]);
  return r.rows[0]?.max == null ? now : Number(r.rows[0].max);
}

/** cursor 停在最早一筆待回填列的 received_at 之前（含同一時間點的列都不可越過）。 */
function cursorUpto(fresh: ScanRow[], pendingAt: number | null): number | null {
  const seen = pendingAt === null ? fresh : fresh.filter((r) => Number(r.received_at) < pendingAt);
  const last = seen.at(-1);
  return last ? Number(last.received_at) : null;
}

/** upto：這批實際看到的最大 received_at（沒有新列或停在待回填之前 → null，cursor 不動）。不用 control-api 的 now，ingest 時鐘較慢時才不會漏列。 */
async function scanGroups(q: Queryable, cursor: number, now: number): Promise<{ keys: GroupKey[]; upto: number | null; nullTs: number; pendingBackfill: number; stalePending: number }> {
  const fresh = (await q.query<ScanRow>(
    `SELECT sensor_id, app_id, src_ip, ts_ms, received_at,
            CASE WHEN ts_ms IS NULL THEN flow_ts_ms(ts) END AS convertible_ms
     FROM flow_events
     WHERE received_at > $1 AND received_at <= $2
     ORDER BY received_at, sensor_id, flow_id LIMIT ${JUDGE_BATCH}`, [cursor, now])).rows;
  // 重疊區只取可分組的列：NULL 列在第一次掃到時已計數，不重複計
  const overlap = (await q.query<KeyRow>(
    `SELECT sensor_id, app_id, src_ip, ts_ms FROM flow_events
     WHERE received_at > $1 AND received_at <= $2 AND ts_ms IS NOT NULL`, [cursor - JUDGE_OVERLAP_MS, cursor])).rows;
  const split = splitPending(fresh, await newestReceivedAt(q, now));
  const visible = split.stopAt === -1 ? fresh : fresh.slice(0, split.stopAt);
  const keys = new Map<string, GroupKey>();
  const addKey = (r: KeyRow): void => {
    const win = Math.floor(Number(r.ts_ms) / FLOW_WINDOW_MS) * FLOW_WINDOW_MS;
    keys.set(JSON.stringify([r.sensor_id, r.app_id, r.src_ip, win]), { sensor_id: r.sensor_id, app_id: r.app_id, src_ip: r.src_ip, win });
  };
  let nullTs = 0;
  for (const r of overlap) addKey(r);
  for (const r of visible) {
    if (r.ts_ms === null) { if (!isPendingBackfill(r)) nullTs += 1; continue; }
    addKey(r);
  }
  return { keys: [...keys.values()], upto: cursorUpto(fresh, split.pendingAt), nullTs, pendingBackfill: split.pendingBackfill, stalePending: split.stalePending };
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

/** 「新的」高嚴重命中：這次寫入才讓 ontime_confidence 第一次 ≥ auto（新命中或重掃跨過）；只有這時評估 E3.A。 */
const isNewHigh = (ontime: number | null, prev: number | null, auto: number): boolean =>
  ontime !== null && ontime >= auto && !(prev !== null && prev >= auto);

type StoredHit = { confidence: number; late: boolean; created: boolean; newHigh: boolean };

/**
 * 命中存好之後的去向：白名單 IP 不開案，E3.A 成立只寫 auto_suppressed{allowlist, case_id:null}；
 * 已在榜 → hit_while_listed；否則累加／提高待審，再評估 E3.A → autoListCase。兩條路徑共用同一個計數函式。
 */
async function routeHit(q: Queryable, k: GroupKey, ctx: TickCtx, h: StoredHit): Promise<void> {
  const { th, isAllowlisted, now, log, hooks, breakerPerHour, autoList } = ctx;
  const ip = hostCidr(k.src_ip)!;
  const e3a = async () => autoList && h.newHigh && e3aHolds(await countHighSeverity(q, ip, th.auto, now));
  if (isAllowlisted(k.src_ip)) {
    if ((await e3a()) && !(await writeSuppressed(q, { reason: "allowlist", ip, case_id: null }, now))) ctx.stats.deduped += 1;
    return;
  }
  if (await onActiveBlocklist(q, k, h.confidence, h.created, ctx)) return;
  if (h.created) await accumulateCase(q, { ip: k.src_ip, confidence: h.confidence, late: h.late }, now);
  else await raiseCaseMax(q, k.src_ip, h.confidence, now);
  if (await e3a()) {
    await hooks.beforeAutoList?.();
    if (await autoListCase(q, ip, now, { log, gates: { breakerPerHour }, afterShare: hooks.afterAllowlistShare })) ctx.stats.deduped += 1;
  }
}

/**
 * 重讀整組並判定；confidence ≥ case → 存命中再交給 routeHit，回 "hit"。
 * src_ip 不是可上榜的主機位址（hostCidr 拒收：127/8、0.0.0.0、多播、link-local、::1、廣播…）→ 整組跳過回 "skipped"，
 * 否則 upsertCaseHit 拋錯會讓整個 tick rollback、cursor 永遠卡住（資安退回 B1）。
 */
async function judgeGroup(q: Queryable, k: GroupKey, ctx: TickCtx): Promise<"hit" | "miss" | "skipped"> {
  if (hostCidr(k.src_ip) === null) return "skipped";
  const rows = (await q.query<FlowEventRow>(
    `SELECT * FROM flow_events WHERE sensor_id = $1 AND app_id = $2 AND src_ip = $3
       AND ts_ms >= $4 AND ts_ms < $5`,
    [k.sensor_id, k.app_id, k.src_ip, k.win, k.win + FLOW_WINDOW_MS])).rows;
  const all = judgeFlows(rows.map(toFlow), ctx.th)[0];
  if (!all?.open_case) return "miss";
  const ontime = rows.filter((r) => Number(r.received_at) - Number(r.ts_ms) <= LATE_MS).map(toFlow);
  const ontimeConfidence = ontime.length > 0 ? judgeFlows(ontime, ctx.th)[0]!.confidence : null;
  const { created, prevOntime } = await upsertCaseHit(q, { src_ip: k.src_ip, sensor_id: k.sensor_id, app_id: k.app_id,
    window_start: k.win, confidence: all.confidence, ontime_confidence: ontimeConfidence }, ctx.now);
  await routeHit(q, k, ctx, { confidence: all.confidence, late: ontime.length < rows.length, created,
    newHigh: isNewHigh(ontimeConfidence, prevOntime, ctx.th.auto) });
  return "hit";
}

/**
 * 組內錯誤的 SQLSTATE。只吞感測器 ts 造成的日期時間資料錯誤（資安 R14a）：
 * 22007 invalid_datetime_format、22008 datetime_field_overflow、22009 invalid_time_zone_displacement_value。
 * 其他 22 類（22P02、22012…）多半是程式或 schema 問題，不能靜默吞掉。
 * ts slice 後判定不再對 ts 做 ::timestamptz（只讀 ts_ms），這層 SAVEPOINT 保留作縱深防禦（Q5）。
 */
const SWALLOWED = new Set(["22007", "22008", "22009"]);
const sqlState = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/**
 * 每組一個 SAVEPOINT（資安退回 B2）：感測器送來 Postgres 不收的 ts（0000 年、offset ±23:59…）在 ts slice 前會讓 ts::timestamptz 拋錯（現已改讀 ts_ms）；
 * 只有 SWALLOWED 內的 SQLSTATE 才 ROLLBACK TO SAVEPOINT 這一組、記入 failed（以 SQLSTATE 計數），其他組照常、cursor 照常前進。
 * 其他錯誤（其他 22 類、40P01 deadlock、55P03 lock_not_available、沒有 code 的…）一律往外丟：整個 tick rollback、cursor 不動，
 * 下一個 tick 重判，否則該 IP 會被 cursor 跳過、永遠不再判定（資安退回 B3）。
 */
async function judgeGroupIsolated(q: Queryable, k: GroupKey, ctx: TickCtx): Promise<"hit" | "miss" | "skipped" | "failed"> {
  await q.query("SAVEPOINT judge_group");
  try {
    const r = await judgeGroup(q, k, ctx);
    await q.query("RELEASE SAVEPOINT judge_group");
    return r;
  } catch (e) {
    const code = sqlState(e);
    if (code === undefined || !SWALLOWED.has(code)) throw e;
    await q.query("ROLLBACK TO SAVEPOINT judge_group");
    ctx.stats.codes.set(code, (ctx.stats.codes.get(code) ?? 0) + 1);
    return "failed";
  }
}

/**
 * 每個 tick 各一行，只記數量／SQLSTATE、不記 IP／ts／錯誤訊息：ts_ms NULL 不分組的列（ts slice，Q6 只記 {null_ts}）、
 * 待回填停點（{pending_backfill}）、超過 lag 上限的待回填（error {stale_pending}）、
 * 跳過的非主機位址組（B1）、失敗回滾的組（B2／B3）、被去重的 hit_while_listed（R5）與 auto_suppressed（A 覆核）。
 */
function logTickCounts(log: TickLog | undefined, n: { skipped: number; failed: number }, stats: TickCtx["stats"]): void {
  if (!log) return;
  const lines: [number, object, string][] = [
    [stats.nullTs, { null_ts: stats.nullTs }, "judge tick skipped rows without ts_ms"],
    [stats.pendingBackfill, { pending_backfill: stats.pendingBackfill }, "judge tick pending backfill"],
    [n.skipped, { skipped: n.skipped }, "judge tick skipped non-host src_ip groups"],
    [n.failed, { failed: n.failed, codes: Object.fromEntries(stats.codes) }, "judge tick rolled back failed groups"],
    [stats.suppressed, { suppressed: stats.suppressed }, "judge tick suppressed hit_while_listed audits (1 per entry per hour)"],
    [stats.deduped, { deduped: stats.deduped }, "judge tick deduped auto_suppressed audits (1 per ip+reason per hour)"],
  ];
  for (const [count, obj, msg] of lines) if (count > 0) log.warn(obj, msg);
  if (stats.stalePending > 0) log.error({ stale_pending: stats.stalePending }, "judge tick skipped stale pending backfill");
}

/** 自動上榜設定（總開關、熔斷 N）；開著才在 tick 開頭判熔斷恢復（關時熔斷狀態原樣不動、不寫 auto_breaker_close）。 */
async function prepareAutoList(q: Queryable, opts: TickOpts, now: number, log?: TickLog): Promise<{ breakerPerHour: number; autoList: boolean }> {
  const breakerPerHour = opts.autoBreakerPerHour ?? AUTO_BREAKER_PER_HOUR;
  const autoList = opts.autoListEnabled ?? AUTO_LIST_ENABLED_DEFAULT;
  if (autoList) await recoverBreakerIfOpen(q, breakerPerHour, now, log);
  return { breakerPerHour, autoList };
}

export async function runJudgeTick(db: Db, now: number, log?: TickLog, opts: TickOpts = {}): Promise<TickResult> {
  if (!(await flowEventsReady(db))) return NOOP;
  return db.tx(async (q): Promise<TickResult> => {
    const lock = await q.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [JUDGE_LOCK]);
    if (lock.rows[0]?.ok !== true) return NOOP;
    const th = await loadThresholds(q, log);
    await expireOpenCases(q, now);
    const { breakerPerHour, autoList } = await prepareAutoList(q, opts, now, log);
    const cur = (await q.query<{ received_upto: string }>("SELECT received_upto FROM judge_cursor WHERE id")).rows[0];
    const { keys, upto, nullTs, pendingBackfill, stalePending } = await scanGroups(q, Number(cur?.received_upto ?? 0), now);
    const ctx: TickCtx = { th, isAllowlisted: await loadAllowlist(q, now), now, log, hooks: opts, breakerPerHour, autoList, stats: { suppressed: 0, deduped: 0, codes: new Map(), nullTs, pendingBackfill, stalePending } };
    const n = { hit: 0, miss: 0, skipped: 0, failed: 0 };
    for (const k of keys) n[await judgeGroupIsolated(q, k, ctx)] += 1;
    logTickCounts(log, n, ctx.stats);
    // R14b（全部組失敗就整個 tick 失敗）已移除（A 組領航員裁示 R18）：ts slice 後判定只讀 ts_ms，22007／22008／22009 只回滾該組、cursor 照常前進；
    // 非這三碼的錯誤仍在 judgeGroupIsolated 往外丟，整個 tick 回滾（B3／R14a）
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
