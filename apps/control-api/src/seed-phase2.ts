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
  const users: [string, string, Role, string?, string?][] = [
    ["operator1", "pass-operator-1", "operator"],
    ["owner1", "pass-owner-1", "app_owner", "app-alpha", "app-alpha-note"],
    ["owner2", "pass-owner-2", "app_owner", "app-beta", "app-beta-secret"],
    ["admin1", "pass-admin-1", "platform_admin"],
  ];
  // 先算完雜湊，再進入交易取鎖，避免持鎖期間做 CPU 密集的 argon2.hash。
  const prepared: { username: string; password_hash: string; role: Role; appId?: string; note?: string }[] = [];
  for (const [u, p, role, appId, note] of users) {
    prepared.push({ username: u, password_hash: await argon2.hash(p), role, appId, note });
  }
  // A 組領航員裁示（未經使用者確認）：交易級 advisory lock，TRUNCATE 與 INSERT
  // 在同一筆 db.tx 內；COMMIT／ROLLBACK 自動釋放，ROLLBACK 失敗則 release(err)。
  await app.db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock($1)", [SEED_LOCK]);
    await q.query(
      "TRUNCATE TABLE alert_outbox, audit_events, thresholds, allowlist_entries, blocklist_entries, blacklist_cases, case_hits, judge_cursor, sensor_tokens, sessions, apps, users, login_failures RESTART IDENTITY CASCADE",
    );
    await q.query("UPDATE auto_breaker SET opened_at = NULL, volume_held = FALSE");
    await q.query("UPDATE approve_guard SET volume_held = FALSE");
    for (const row of prepared) {
      const id = await insertUser(q, { username: row.username, password_hash: row.password_hash, role: row.role });
      if (row.appId) {
        await q.query("INSERT INTO apps (id, owner_id, note) VALUES ($1,$2,$3)", [row.appId, id, row.note]);
      }
    }
  });
}
