import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ADMIN_API_PATHS, AllowlistCreateSchema, AllowlistUpdateSchema,
} from "@semantic-defense/contracts";
import type { Db } from "./db.js";
import { writeAudit } from "./audit.js";
import { ALLOWLIST_COLS, toAllowlistEntry, type AllowlistRow } from "./allowlist-row.js";
import { revokeContainedBlocks } from "./revoke-contained.js";
import type { Role } from "./auth.js";
import { CRITICAL_ALLOWLIST_ACTOR } from "./critical-allowlist.js";

/**
 * ③a 白名單 CRUD（MONITOR §3 白名單項目、§7a：僅 platform_admin）。
 * - 時間以 epoch ms 存；回應轉 RFC3339。entry_id／created_by（username）／created_at 由伺服端填。
 * - expires_at 非 null 時須 > created_at，否則 400。
 * - 每筆寫入與稽核（whitelist.create／update／delete）同一 Db.tx；稽核失敗則不生效。
 * - 新增時同一交易撤回被該 CIDR 完全包含（ip::inet <<= cidr）且仍生效的黑名單（auto 與 manual），每筆寫 blacklist.revoke。
 */
const ADMIN: Role[] = ["platform_admin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Params = { Params: { entryId: string } };

const expiresMs = (s: string | null) => (s === null ? null : Date.parse(s));
const validExpiry = (createdAt: number, exp: number | null) => exp === null || exp > createdAt;

export function registerWhitelistRoutes(app: FastifyInstance, db: Db, now: () => number): void {
  const P = ADMIN_API_PATHS;
  app.get(P.whitelist, { config: { roles: ADMIN } }, async () => {
    const r = await db.query<AllowlistRow>(`SELECT ${ALLOWLIST_COLS} FROM allowlist_entries ORDER BY created_at, entry_id`);
    return { items: r.rows.map(toAllowlistEntry) };
  });

  app.post(P.whitelist, { config: { roles: ADMIN } }, async (req, reply) => {
    const p = AllowlistCreateSchema.safeParse(req.body);
    const at = now();
    if (!p.success || !validExpiry(at, expiresMs(p.data.expires_at))) return reply.code(400).send({ error: "請求格式錯誤" });
    const actor = req.user!.username;
    const row = await db.tx(async (q) => {
      const r = await q.query<AllowlistRow>(
        `INSERT INTO allowlist_entries (${ALLOWLIST_COLS}) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${ALLOWLIST_COLS}`,
        [randomUUID(), p.data.cidr, p.data.reason, actor, at, expiresMs(p.data.expires_at)],
      );
      const e = toAllowlistEntry(r.rows[0]!);
      await revokeContainedBlocks(q, { cidr: e.cidr, allowlistEntryId: e.entry_id, actor, at });
      await writeAudit(q, { action: "whitelist.create", actor, sensor_id: null, at, detail: { ...e } });
      return e;
    });
    return reply.code(201).send(row);
  });

  app.patch<Params>(P.whitelistEntry, { config: { roles: ADMIN } }, async (req, reply) => {
    const id = req.params.entryId;
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: "查無白名單項目" });
    const p = AllowlistUpdateSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "請求格式錯誤" });
    const out = await db.tx(async (q) => {
      const cur = (await q.query<AllowlistRow>(`SELECT ${ALLOWLIST_COLS} FROM allowlist_entries WHERE entry_id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) return 404 as const;
      if (cur.created_by === CRITICAL_ALLOWLIST_ACTOR && expiresMs(p.data.expires_at) !== null) return 409 as const;
      if (!validExpiry(Number(cur.created_at), expiresMs(p.data.expires_at))) return 400 as const;
      const r = await q.query<AllowlistRow>(
        `UPDATE allowlist_entries SET reason = $2, expires_at = $3 WHERE entry_id = $1 RETURNING ${ALLOWLIST_COLS}`,
        [id, p.data.reason, expiresMs(p.data.expires_at)],
      );
      const e = toAllowlistEntry(r.rows[0]!);
      await writeAudit(q, { action: "whitelist.update", actor: req.user!.username, sensor_id: null, at: now(),
        detail: { entry_id: id, before: toAllowlistEntry(cur), after: e } });
      return e;
    });
    if (out === 404) return reply.code(404).send({ error: "查無白名單項目" });
    if (out === 400) return reply.code(400).send({ error: "請求格式錯誤" });
    if (out === 409) return reply.code(409).send({ error: "安裝種子不可刪除或設定到期" });
    return out;
  });

  app.delete<Params>(P.whitelistEntry, { config: { roles: ADMIN } }, async (req, reply) => {
    const id = req.params.entryId;
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: "查無白名單項目" });
    const out = await db.tx(async (q) => {
      const cur = (await q.query<AllowlistRow>(`SELECT ${ALLOWLIST_COLS} FROM allowlist_entries WHERE entry_id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) return 404 as const;
      if (cur.created_by === CRITICAL_ALLOWLIST_ACTOR) return 409 as const;
      await q.query(`DELETE FROM allowlist_entries WHERE entry_id = $1`, [id]);
      await writeAudit(q, { action: "whitelist.delete", actor: req.user!.username, sensor_id: null, at: now(),
        detail: { ...toAllowlistEntry(cur) } });
      return 204 as const;
    });
    if (out === 404) return reply.code(404).send({ error: "查無白名單項目" });
    if (out === 409) return reply.code(409).send({ error: "安裝種子不可刪除或設定到期" });
    return reply.code(204).send();
  });
}
