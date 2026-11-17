/**
 * TEST/DEV ONLY — 含明碼測試帳密。生產入口不得呼叫。
 * 驗收測試經 app.ts 再匯出 seedPhase2Fixtures。
 */
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import type { Role } from "./auth.js";
import { insertUser } from "./users.js";

type SeedApp = FastifyInstance & { db: Db };

const SEED_LOCK = 872_364_202;

/** 清空第 2 階段表後寫入固定種子（含 login_failures，因測試 truncate 未列該表）。 */
export async function seedPhase2Fixtures(app: SeedApp): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seedPhase2Fixtures 禁止在 production 呼叫（含明碼測試帳密）");
  }
  // A 組領航員裁示（未經使用者確認）：session advisory lock、TRUNCATE、unlock 必須在同一條連線；
  // 經 pool.query 會分到不同連線，unlock 落空而泄漏 SEED_LOCK（ci 步驟 1 卡住的成因之一）。
  await app.db.withSession(async (q) => {
    await q.query("SELECT pg_advisory_lock($1)", [SEED_LOCK]);
    try {
      await q.query(
        "TRUNCATE TABLE alert_outbox, audit_events, thresholds, allowlist_entries, blocklist_entries, blacklist_cases, case_hits, judge_cursor, sensor_tokens, sessions, apps, users, login_failures RESTART IDENTITY CASCADE",
      );
      await q.query("UPDATE auto_breaker SET opened_at = NULL, volume_held = FALSE");
      await q.query("UPDATE approve_guard SET volume_held = FALSE");
      const users: [string, string, Role, string?, string?][] = [
        ["operator1", "pass-operator-1", "operator"],
        ["owner1", "pass-owner-1", "app_owner", "app-alpha", "app-alpha-note"],
        ["owner2", "pass-owner-2", "app_owner", "app-beta", "app-beta-secret"],
        ["admin1", "pass-admin-1", "platform_admin"],
      ];
      for (const [u, p, role, appId, note] of users) {
        const id = await insertUser(q, { username: u, password_hash: await argon2.hash(p), role });
        if (appId) {
          await q.query("INSERT INTO apps (id, owner_id, note) VALUES ($1,$2,$3)", [appId, id, note]);
        }
      }
    } finally {
      await q.query("SELECT pg_advisory_unlock($1)", [SEED_LOCK]);
    }
  });
}
