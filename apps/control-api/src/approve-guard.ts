import type { Db, Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import { enqueueAlerts, type AlertChannel } from "./alert-outbox.js";
import { volumeThreshold } from "./auto-breaker.js";
import { approveScope } from "./net-scope.js";
import { parseBoundInt } from "./judge-alerts.js";

/**
 * 人工核准防護（A 組領航員裁示，未經使用者確認）。
 * - 上限：每個 operator 滑動 1 小時內成功核准（blocklist_entries source=manual、approved_by=操作者）達 N 筆後回 429；
 *   被擋的嘗試不計入（計數來源只有成功的 entry）。N 預設 50、範圍 1–200，環境變數 SD_APPROVE_PER_HOUR。
 * - 並發：先 SHARE（白名單）再拿每個 actor 一把 xact advisory lock，才計數；不拿 AUTO_LOCK。
 * - 被擋：主交易回滾後另開短交易寫 blacklist.approve_blocked {case_id, reason}（不含 IP）；
 *   cap 同一 operator、其他 reason 同一案件，1 小時內最多一筆。其他 409 不寫。
 * - 位址範圍：內網（RFC1918、CGNAT、ULA）預設可封鎖（使用者決定，由軟體大總召轉達）；
 *   SD_APPROVE_INTERNAL_SCOPE 改成 none／v4／v6 即禁止封鎖對應內網，回 409。never 類不受開關影響，一律 409。
 *   白名單先判（已在白名單 409 優先）。
 * - 告警：approve_cap 跟 cap 稽核同一筆短交易、同一去重；approve_volume 在成功核准的交易內判，
 *   單一 operator ≥ ceil(0.8×上限) 或全體 ≥ 100／小時即入列，approve_guard.volume_held 旗標每段只告一次。
 */
export const APPROVE_LOCK = 872_364_215;
export const APPROVE_WINDOW_MS = 60 * 60_000;
export const APPROVE_PER_HOUR_DEFAULT = 50;
export const APPROVE_PER_HOUR_MIN = 1;
export const APPROVE_PER_HOUR_MAX = 200;
export const APPROVE_BLOCKED_EVERY_MS = 60 * 60_000;
export const APPROVE_VOLUME_GLOBAL_PER_HOUR = 100;
export const APPROVE_CAP_MESSAGE = "核准次數已達上限，請稍後再試";

export type ApproveBlockReason = "cap" | "internal_scope" | "never_scope";

export const APPROVE_INTERNAL_SCOPES = ["none", "v4", "v6", "all"] as const;
export type ApproveInternalScope = (typeof APPROVE_INTERNAL_SCOPES)[number];
/** 內網是否預設可封鎖：只改這個常數（與部署檢查表）。使用者決定（由軟體大總召轉達）：all。 */
export const APPROVE_INTERNAL_SCOPE_DEFAULT: ApproveInternalScope = "all";
export const APPROVE_INTERNAL_MESSAGE = "內網位址不可核准";
export const APPROVE_NEVER_MESSAGE = "此位址不可核准";

/** 防護擋下：主交易回滾，由路由回 status＋error（不含 IP）。 */
export class ApproveBlocked extends Error {
  constructor(readonly reason: ApproveBlockReason, readonly status: 409 | 429, readonly error: string) {
    super(error);
    this.name = "ApproveBlocked";
  }
}

export type ApproveGuardConfig = { perHour: number; internalScope: ApproveInternalScope; channels: readonly AlertChannel[] };

/** buildApp 選項優先（測試注入）；否則讀 SD_APPROVE_INTERNAL_SCOPE，未設定用預設常數。無效值啟動時拋錯。 */
export function resolveApproveInternalScope(env: NodeJS.ProcessEnv, opt?: ApproveInternalScope): ApproveInternalScope {
  const raw = opt ?? env.SD_APPROVE_INTERNAL_SCOPE?.trim();
  if (raw === undefined || raw === "") return APPROVE_INTERNAL_SCOPE_DEFAULT;
  const hit = APPROVE_INTERNAL_SCOPES.find((v) => v === raw);
  if (!hit) throw new Error(`SD_APPROVE_INTERNAL_SCOPE 必須是 ${APPROVE_INTERNAL_SCOPES.join("／")}`);
  return hit;
}


/** 案件位址不在允許範圍即拋 ApproveBlocked（409）：never 一律擋；內網依設定。 */
export function assertApprovableScope(ip: string, setting: ApproveInternalScope): void {
  const scope = approveScope(ip);
  if (scope === "public") return;
  if (scope === "never") throw new ApproveBlocked("never_scope", 409, APPROVE_NEVER_MESSAGE);
  const family = scope === "internal_v4" ? "v4" : "v6";
  if (setting !== "all" && setting !== family) throw new ApproveBlocked("internal_scope", 409, APPROVE_INTERNAL_MESSAGE);
}

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
  await lockApprover(q, actor);
  const r = await q.query<{ n: string }>(
    "SELECT count(*) AS n FROM blocklist_entries WHERE source = 'manual' AND approved_by = $1 AND created_at > $2",
    [actor, at - APPROVE_WINDOW_MS],
  );
  if (Number(r.rows[0]!.n) >= perHour) throw new ApproveBlocked("cap", 429, APPROVE_CAP_MESSAGE);
}

/** 每個 actor 一把 xact advisory lock（兩參數版本；hashtext 碰撞只會多序列化，不會算錯）。 */
async function lockApprover(q: Queryable, actor: string): Promise<void> {
  await q.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [APPROVE_LOCK, actor]);
}

export type BlockedCtx = { id: string; at: number; actor: string };

/** 主交易已回滾後呼叫：另開短交易，去重後寫 blacklist.approve_blocked。 */
export async function recordApproveBlocked(
  db: Db, c: BlockedCtx, reason: ApproveBlockReason, channels: readonly AlertChannel[],
): Promise<void> {
  await db.tx(async (q) => {
    await lockApprover(q, c.actor);
    const since = c.at - APPROVE_BLOCKED_EVERY_MS;
    const dup = reason === "cap"
      ? await q.query(
        `SELECT 1 FROM audit_events WHERE action = 'blacklist.approve_blocked'
           AND actor = $1 AND detail->>'reason' = 'cap' AND at > $2 LIMIT 1`, [c.actor, since])
      : await q.query(
        `SELECT 1 FROM audit_events WHERE action = 'blacklist.approve_blocked'
           AND detail->>'case_id' = $1 AND detail->>'reason' = $2 AND at > $3 LIMIT 1`, [c.id, reason, since]);
    if (dup.rows.length > 0) return;
    const auditId = await writeAudit(q, {
      action: "blacklist.approve_blocked", actor: c.actor, sensor_id: null, at: c.at, detail: { case_id: c.id, reason },
    });
    if (reason === "cap") await enqueueAlerts(q, { channels, kind: "approve_cap", now: c.at, auditId });
  });
}

/**
 * 成功核准的交易內、entry 寫入之後呼叫（已持有 SHARE 與 actor 鎖）。先以 FOR UPDATE 鎖旗標列，
 * 讓不同 operator 的並發核准在判斷旗標時序列化；鎖順序仍是 SHARE → actor 鎖 → 旗標列。
 */
export async function maybeEnqueueApproveVolume(q: Queryable, actor: string, at: number, guard: ApproveGuardConfig): Promise<void> {
  await q.query("INSERT INTO approve_guard (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING");
  const held = (await q.query<{ volume_held: boolean }>("SELECT volume_held FROM approve_guard WHERE id FOR UPDATE")).rows[0]!.volume_held;
  const r = await q.query<{ mine: string; total: string }>(
    `SELECT count(*) FILTER (WHERE approved_by = $1) AS mine, count(*) AS total
     FROM blocklist_entries WHERE source = 'manual' AND created_at > $2`, [actor, at - APPROVE_WINDOW_MS]);
  const over = Number(r.rows[0]!.mine) >= volumeThreshold(guard.perHour) || Number(r.rows[0]!.total) >= APPROVE_VOLUME_GLOBAL_PER_HOUR;
  if (over === held) return;
  await q.query("UPDATE approve_guard SET volume_held = $1 WHERE id", [over]);
  if (over) await enqueueAlerts(q, { channels: guard.channels, kind: "approve_volume", now: at });
}
