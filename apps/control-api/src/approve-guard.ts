import type { Queryable } from "./db.js";
import { parseBoundInt } from "./judge-alerts.js";

/**
 * 人工核准防護（A 組領航員裁示，未經使用者確認）。
 * - 上限：每個 operator 滑動 1 小時內成功核准（blocklist_entries source=manual、approved_by=操作者）達 N 筆後回 429；
 *   被擋的嘗試不計入（計數來源只有成功的 entry）。N 預設 50、範圍 1–200，環境變數 SD_APPROVE_PER_HOUR。
 * - 並發：先 SHARE（白名單）再拿每個 actor 一把 xact advisory lock，才計數；不拿 AUTO_LOCK。
 */
export const APPROVE_LOCK = 872_364_215;
export const APPROVE_WINDOW_MS = 60 * 60_000;
export const APPROVE_PER_HOUR_DEFAULT = 50;
export const APPROVE_PER_HOUR_MIN = 1;
export const APPROVE_PER_HOUR_MAX = 200;
export const APPROVE_CAP_MESSAGE = "核准次數已達上限，請稍後再試";

export type ApproveBlockReason = "cap";

/** 防護擋下：主交易回滾，由路由回 status＋error（不含 IP）。 */
export class ApproveBlocked extends Error {
  constructor(readonly reason: ApproveBlockReason, readonly status: 409 | 429, readonly error: string) {
    super(error);
    this.name = "ApproveBlocked";
  }
}

export type ApproveGuardConfig = { perHour: number };

/** buildApp 選項優先（測試注入）；否則讀環境變數。無效值啟動時拋錯。 */
export function resolveApprovePerHour(env: NodeJS.ProcessEnv, opt?: number): number {
  if (opt !== undefined) {
    if (!Number.isSafeInteger(opt) || opt < APPROVE_PER_HOUR_MIN || opt > APPROVE_PER_HOUR_MAX) {
      throw new Error(`approvePerHour 必須是 ${APPROVE_PER_HOUR_MIN}–${APPROVE_PER_HOUR_MAX} 的整數`);
    }
    return opt;
  }
  return parseBoundInt(env.SD_APPROVE_PER_HOUR, APPROVE_PER_HOUR_DEFAULT, APPROVE_PER_HOUR_MIN, APPROVE_PER_HOUR_MAX, "SD_APPROVE_PER_HOUR");
}

/** 呼叫端須已持有白名單 SHARE。拿 actor 鎖後計數，達上限即拋 ApproveBlocked（429）。 */
export async function assertUnderApproveCap(q: Queryable, actor: string, at: number, perHour: number): Promise<void> {
  await q.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [APPROVE_LOCK, actor]);
  const r = await q.query<{ n: string }>(
    "SELECT count(*) AS n FROM blocklist_entries WHERE source = 'manual' AND approved_by = $1 AND created_at > $2",
    [actor, at - APPROVE_WINDOW_MS],
  );
  if (Number(r.rows[0]!.n) >= perHour) throw new ApproveBlocked("cap", 429, APPROVE_CAP_MESSAGE);
}
