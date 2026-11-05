/**
 * TEST/DEV ONLY — 含明碼測試帳密。生產入口不得呼叫。
 * 驗收測試經 app.ts 再匯出 seedPhase2Fixtures。
 */
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import type { Role } from "./auth.js";

type SeedApp = FastifyInstance & { db: Db };

export async function seedPhase2Fixtures(app: SeedApp): Promise<void> {
  const users: [string, string, Role, string?, string?][] = [
    ["operator1", "pass-operator-1", "operator"],
    ["owner1", "pass-owner-1", "app_owner", "app-alpha", "app-alpha-note"],
    ["owner2", "pass-owner-2", "app_owner", "app-beta", "app-beta-secret"],
    ["admin1", "pass-admin-1", "platform_admin"],
  ];
  for (const [u, p, role, appId, note] of users) {
    const r = await app.db.query<{ id: number }>(
      "INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id",
      [u, await argon2.hash(p), role],
    );
    if (appId) {
      await app.db.query("INSERT INTO apps (id, owner_id, note) VALUES ($1,$2,$3)",
        [appId, r.rows[0]!.id, note]);
    }
  }
}
