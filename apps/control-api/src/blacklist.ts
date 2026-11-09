import type { FastifyInstance } from "fastify";
import { ADMIN_API_PATHS, type BlocklistEntry } from "@semantic-defense/contracts";
import type { Db } from "./db.js";
import { writeAudit } from "./audit.js";
import type { Role } from "./auth.js";

/**
 * ③b 已上榜黑名單：讀取與撤回（MONITOR §7a：僅 operator）。
 * - 時間以 epoch ms 存；回應轉 RFC3339，形狀＝contracts 黑名單項目。
 * - 撤回：revoked_at IS NULL 才更新（條件式 UPDATE 序列化並行；兩人同時只一個成功），與 blacklist.revoke 稽核同一 Db.tx。
 *   已撤回 → 409、不存在 → 404，皆不寫稽核。
 */
const OPERATOR: Role[] = ["operator"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const BLOCKLIST_COLS =
  "entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at";
export type BlocklistRow = {
  entry_id: string; ip: string; source: "manual" | "auto"; confidence: number; case_id: string;
  created_at: string; expires_at: string; approved_by: string; approved_at: string; revoked_at: string | null;
};

const iso = (ms: string | number) => new Date(Number(ms)).toISOString();
export const toBlocklistEntry = (r: BlocklistRow): BlocklistEntry => ({
  entry_id: r.entry_id, ip: r.ip, source: r.source, confidence: r.confidence, case_id: r.case_id,
  created_at: iso(r.created_at), expires_at: iso(r.expires_at), approved_by: r.approved_by,
  approved_at: iso(r.approved_at), revoked_at: r.revoked_at === null ? null : iso(r.revoked_at),
});

export function registerBlacklistRoutes(app: FastifyInstance, db: Db, now: () => number): void {
  const P = ADMIN_API_PATHS;
  app.get(P.blacklist, { config: { roles: OPERATOR } }, async () => {
    const r = await db.query<BlocklistRow>(`SELECT ${BLOCKLIST_COLS} FROM blocklist_entries ORDER BY created_at, entry_id`);
    return { items: r.rows.map(toBlocklistEntry) };
  });

  app.post<{ Params: { entryId: string } }>(P.blacklistRevoke, { config: { roles: OPERATOR } }, async (req, reply) => {
    const id = req.params.entryId;
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: "查無黑名單項目" });
    const at = now();
    const out = await db.tx(async (q) => {
      const r = await q.query<BlocklistRow>(
        `UPDATE blocklist_entries SET revoked_at = $2 WHERE entry_id = $1 AND revoked_at IS NULL RETURNING ${BLOCKLIST_COLS}`,
        [id, at],
      );
      const row = r.rows[0];
      if (!row) {
        const exists = await q.query("SELECT 1 FROM blocklist_entries WHERE entry_id = $1", [id]);
        return exists.rows.length ? (409 as const) : (404 as const);
      }
      const e = toBlocklistEntry(row);
      await writeAudit(q, { action: "blacklist.revoke", actor: req.user!.username, sensor_id: null, at,
        detail: { entry_id: e.entry_id, ip: e.ip, source: e.source, case_id: e.case_id } });
      return e;
    });
    if (out === 404) return reply.code(404).send({ error: "查無黑名單項目" });
    if (out === 409) return reply.code(409).send({ error: "已撤回" });
    return out;
  });
}
