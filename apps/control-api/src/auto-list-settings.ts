import type { FastifyInstance, FastifyRequest } from "fastify";
import { ADMIN_API_PATHS, AutoListSettingSchema, type AutoListSetting } from "@semantic-defense/contracts";
import type { Db, Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import type { Role } from "./auth.js";

/**
 * 自動上榜總開關（單列表 auto_list_settings，預設關閉，無環境變數）。
 * 僅 platform_admin；PUT 以 FOR UPDATE 鎖列，與 settings.auto_list.update 同一 tx；
 * 值未變不寫稽核。細節為 A 組領航員裁示（未經使用者確認）。
 */
const ADMIN: Role[] = ["platform_admin"];

/**
 * 缺列或讀失敗時的 fallback：關（fail-closed）。生產的唯一開關來源是 auto_list_settings 列（預設 false），
 * 不再是「改這個常數為 on」；judge.ts 轉出同一常數。
 */
export const AUTO_LIST_ENABLED_DEFAULT = false;

/** 讀目前開關；缺列視為 AUTO_LIST_ENABLED_DEFAULT（關）。GET 與 tick 讀取共用。 */
export async function loadAutoListSetting(db: Queryable): Promise<AutoListSetting> {
  const row = (await db.query<{ enabled: boolean }>("SELECT enabled FROM auto_list_settings WHERE id")).rows[0];
  return { enabled: row ? row.enabled === true : AUTO_LIST_ENABLED_DEFAULT };
}

/**
 * 判定 tick 用（每個 tick 一次，JUDGE_LOCK 之後）：在 tick tx 內以 SAVEPOINT 包住讀取，
 * 失敗則 ROLLBACK TO SAVEPOINT（tick tx 不會因此中止）並視為關閉；log 只帶固定 error_class，不帶例外正文。
 */
export async function readAutoListEnabledInTx(q: Queryable, log?: { error(obj: object, msg: string): void }): Promise<boolean> {
  await q.query("SAVEPOINT auto_list_setting");
  try {
    const { enabled } = await loadAutoListSetting(q);
    await q.query("RELEASE SAVEPOINT auto_list_setting");
    return enabled;
  } catch {
    await q.query("ROLLBACK TO SAVEPOINT auto_list_setting");
    log?.error({ error_class: "auto_list_setting_read" }, "auto-list setting read failed");
    return AUTO_LIST_ENABLED_DEFAULT;
  }
}

async function putAutoListSetting(db: Db, actor: string, after: AutoListSetting, at: number): Promise<AutoListSetting> {
  return db.tx(async (q) => {
    await q.query(
      "INSERT INTO auto_list_settings (id, enabled) VALUES (TRUE, FALSE) ON CONFLICT (id) DO NOTHING",
    );
    const locked = (await q.query<{ enabled: boolean }>(
      "SELECT enabled FROM auto_list_settings WHERE id FOR UPDATE",
    )).rows[0];
    const before: AutoListSetting = { enabled: locked?.enabled === true };
    if (before.enabled === after.enabled) return after;
    await q.query("UPDATE auto_list_settings SET enabled = $1 WHERE id", [after.enabled]);
    await writeAudit(q, {
      action: "settings.auto_list.update",
      actor,
      sensor_id: null,
      at,
      detail: { before, after },
    });
    return after;
  });
}

/**
 * 三向交握佐證（(d) tcp_hs）是否已上線。軟體大總召裁示（未經使用者確認，依 11/9 使用者決定）：
 * 未就緒前 PUT enabled:true 一律 409 並寫 update_blocked；關閉一律允許。此 PUT 是開關值寫進 DB 的唯一途徑，tick 不另檢查。
 */
export const HANDSHAKE_EVIDENCE_READY = false;

/**
 * 只給這條 PUT 的來源檢查（資安提出；全域寫入方法檢查留給強化切片）：Sec-Fetch-Site 有值時只接受
 * same-origin／none；Origin 有值時必須等於自身來源（scheme + Host）。兩者皆無＝非瀏覽器管理用戶端，放行。
 */
function sameOriginRequest(req: FastifyRequest): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === `${req.protocol}://${req.headers.host ?? ""}`;
}

async function writeBlocked(db: Db, actor: string, at: number): Promise<void> {
  await writeAudit(db, {
    action: "settings.auto_list.update_blocked",
    actor,
    sensor_id: null,
    at,
    detail: { requested: { enabled: true }, reason: "handshake_not_ready" },
  });
}

/** handshakeReady：生產固定 HANDSHAKE_EVIDENCE_READY；buildApp 的覆寫僅限 NODE_ENV=test。 */
export function registerAutoListSettingRoutes(app: FastifyInstance, db: Db, now: () => number, handshakeReady = HANDSHAKE_EVIDENCE_READY): void {
  const path = ADMIN_API_PATHS.autoList;
  app.get(path, { config: { roles: ADMIN } }, async () => loadAutoListSetting(db));
  // 順序：角色（authz preHandler）→ 來源 → 格式 → 409 閘門 → 寫入；來源不符與格式錯誤不寫稽核。
  app.put(path, { config: { roles: ADMIN } }, async (req, reply) => {
    if (!sameOriginRequest(req)) return reply.code(403).send({ error: "請求來源不符" });
    const parsed = AutoListSettingSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "請求格式錯誤" });
    if (parsed.data.enabled && !handshakeReady) {
      await writeBlocked(db, req.user!.username, now());
      return reply.code(409).send({ error: "三向交握佐證尚未上線，暫不能開啟自動封鎖" });
    }
    return putAutoListSetting(db, req.user!.username, parsed.data, now());
  });
}
