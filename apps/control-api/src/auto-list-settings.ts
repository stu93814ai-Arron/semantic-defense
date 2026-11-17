import type { FastifyInstance } from "fastify";
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

/** 讀目前開關；缺列視為關閉。GET 與後續 tick 讀取共用（tick 的 fail-closed 另包 SAVEPOINT）。 */
export async function loadAutoListSetting(db: Queryable): Promise<AutoListSetting> {
  const r = await db.query<{ enabled: boolean }>("SELECT enabled FROM auto_list_settings WHERE id");
  return { enabled: r.rows[0]?.enabled === true };
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

export function registerAutoListSettingRoutes(app: FastifyInstance, db: Db, now: () => number): void {
  const path = ADMIN_API_PATHS.autoList;
  app.get(path, { config: { roles: ADMIN } }, async () => loadAutoListSetting(db));
  app.put(path, { config: { roles: ADMIN } }, async (req, reply) => {
    const parsed = AutoListSettingSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "請求格式錯誤" });
    return putAutoListSetting(db, req.user!.username, parsed.data, now());
  });
}
