import { flowEventsReady } from "@semantic-defense/flow-store/read";
import { enqueueAlerts, type AlertChannel } from "./alert-outbox.js";
import type { Db, Queryable } from "./db.js";
import { PENDING_BACKFILL_MAX_LAG_MS, runJudgeTick, type TickLog, type TickOpts, type TickResult } from "./judge.js";

/** N 預設 3 為 A 組領航員建議；驗收條件為資安提出。 */
export const DEFAULT_TICK_FAIL_ALERT_N = 3;
/** 與 R-B PENDING_BACKFILL_MAX_LAG_MS 對齊（10 分鐘）。 */
export const DEFAULT_CURSOR_LAG_MS = PENDING_BACKFILL_MAX_LAG_MS;

export type JudgeAlertConfig = { failN: number; lagMs: number };
export type JudgeTickOutcome = "success" | "failure" | "noop";
export type JudgeHealth = { tick_fail_streak: number; cursor_lag_seconds: number; stale_pending_total: number };
export type ApplyJudgeAlertsOpts = {
  now: number;
  channels: readonly AlertChannel[];
  cfg: JudgeAlertConfig;
  outcome: JudgeTickOutcome;
  stalePending?: number;
};

type CursorAlertState = {
  cursor: number;
  failStreak: number;
  lagAlerted: boolean;
  staleAlerted: boolean;
  stalePendingTotal: number;
};

function throwInvalid(name: string, hint: string): never {
  throw new Error(`${name} ${hint}`);
}

function parseBoundInt(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throwInvalid(name, `必須是 ${min}–${max} 的整數`);
  return n;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throwInvalid(name, "必須是正整數");
  return n;
}

export function parseJudgeAlertConfig(env: Record<string, string | undefined> = process.env): JudgeAlertConfig {
  return {
    failN: parseBoundInt(env.SD_JUDGE_TICK_FAIL_ALERT_N, DEFAULT_TICK_FAIL_ALERT_N, 3, 5, "SD_JUDGE_TICK_FAIL_ALERT_N"),
    lagMs: parsePositiveInt(env.SD_JUDGE_CURSOR_LAG_MS, DEFAULT_CURSOR_LAG_MS, "SD_JUDGE_CURSOR_LAG_MS"),
  };
}

async function measureCursorLag(q: Queryable, cursor: number): Promise<number> {
  if (!(await flowEventsReady(q))) return 0;
  const r = await q.query<{ max: string | null }>("SELECT max(received_at) AS max FROM flow_events");
  if (r.rows[0]?.max == null) return 0;
  return Math.max(0, Number(r.rows[0].max) - cursor);
}

async function loadState(q: Queryable): Promise<CursorAlertState> {
  await q.query("INSERT INTO judge_cursor (id, received_upto) VALUES (TRUE, 0) ON CONFLICT (id) DO NOTHING");
  const row = (await q.query<{
    received_upto: string; fail_streak: number; lag_alerted: boolean; stale_alerted: boolean; stale_pending_total: string;
  }>("SELECT received_upto, fail_streak, lag_alerted, stale_alerted, stale_pending_total FROM judge_cursor WHERE id FOR UPDATE")).rows[0]!;
  return {
    cursor: Number(row.received_upto),
    failStreak: row.fail_streak,
    lagAlerted: row.lag_alerted,
    staleAlerted: row.stale_alerted,
    stalePendingTotal: Number(row.stale_pending_total),
  };
}

function nextStreak(prev: number, outcome: JudgeTickOutcome): number {
  if (outcome === "success") return 0;
  if (outcome === "failure") return prev + 1;
  return prev;
}

/** 跨過 N 時告一次（用 >=，突變改成 > 即 off-by-one）。 */
function shouldAlertTickFail(prev: number, next: number, n: number): boolean {
  return next >= n && prev < n;
}

function nextOnceFlag(active: boolean, wasAlerted: boolean): { alerted: boolean; enqueue: boolean } {
  if (active) return { alerted: true, enqueue: !wasAlerted };
  return { alerted: false, enqueue: false };
}

function nextLagFlag(lagMs: number, threshold: number, wasAlerted: boolean): { alerted: boolean; enqueue: boolean } {
  return nextOnceFlag(lagMs > threshold, wasAlerted);
}

/** 只在成功 tick 判斷：stale>0 且尚未發過才告；stale=0 時重置。失敗／NOOP 不改旗標。 */
function nextStaleFlag(outcome: JudgeTickOutcome, stale: number, wasAlerted: boolean): { alerted: boolean; enqueue: boolean } {
  if (outcome !== "success") return { alerted: wasAlerted, enqueue: false };
  return nextOnceFlag(stale > 0, wasAlerted);
}

async function applyJudgeAlertsTx(q: Queryable, opts: ApplyJudgeAlertsOpts): Promise<void> {
  const state = await loadState(q);
  const lagMs = await measureCursorLag(q, state.cursor);
  const failStreak = nextStreak(state.failStreak, opts.outcome);
  const lag = nextLagFlag(lagMs, opts.cfg.lagMs, state.lagAlerted);
  const stale = opts.outcome === "success" ? (opts.stalePending ?? 0) : 0;
  const staleFlag = nextStaleFlag(opts.outcome, stale, state.staleAlerted);
  const total = state.stalePendingTotal + stale;
  const base = { channels: opts.channels, now: opts.now };
  if (shouldAlertTickFail(state.failStreak, failStreak, opts.cfg.failN)) {
    await enqueueAlerts(q, { ...base, kind: "tick_fail", streak: failStreak });
  }
  if (lag.enqueue) await enqueueAlerts(q, { ...base, kind: "cursor_lag", lag_ms: lagMs });
  if (staleFlag.enqueue) await enqueueAlerts(q, { ...base, kind: "stale_pending", stale_pending: stale });
  await q.query(
    "UPDATE judge_cursor SET fail_streak = $1, lag_alerted = $2, stale_alerted = $3, stale_pending_total = $4 WHERE id",
    [failStreak, lag.alerted, staleFlag.alerted, total],
  );
}

export async function applyJudgeAlerts(db: Db, opts: ApplyJudgeAlertsOpts): Promise<void> {
  await db.tx((q) => applyJudgeAlertsTx(q, opts));
}

export async function judgeHealthCounts(db: Queryable): Promise<JudgeHealth> {
  const row = (await db.query<{ received_upto: string; fail_streak: number; stale_pending_total: string }>(
    "SELECT received_upto, fail_streak, stale_pending_total FROM judge_cursor WHERE id",
  )).rows[0];
  const lagMs = await measureCursorLag(db, Number(row?.received_upto ?? 0));
  return {
    tick_fail_streak: row?.fail_streak ?? 0,
    cursor_lag_seconds: Math.floor(lagMs / 1000),
    stale_pending_total: Number(row?.stale_pending_total ?? 0),
  };
}

async function settleAlerts(
  db: Db, now: number, opts: TickOpts, cfg: JudgeAlertConfig,
  outcome: JudgeTickOutcome, stalePending: number, log?: TickLog,
): Promise<void> {
  try {
    await applyJudgeAlerts(db, { now, channels: opts.alertChannels ?? [], cfg, outcome, stalePending });
  } catch {
    log?.error({ error_class: "judge_alert_apply" }, "judge alert apply failed");
  }
}

export async function runJudgeTickWithAlerts(
  db: Db, now: number, log: TickLog | undefined, opts: TickOpts, cfg: JudgeAlertConfig,
): Promise<TickResult> {
  try {
    const r = await runJudgeTick(db, now, log, opts);
    await settleAlerts(db, now, opts, cfg, r.ran ? "success" : "noop", r.stalePending, log);
    return r;
  } catch (err) {
    await settleAlerts(db, now, opts, cfg, "failure", 0, log);
    throw err;
  }
}
