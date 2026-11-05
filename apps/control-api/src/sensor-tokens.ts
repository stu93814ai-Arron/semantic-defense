import { randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import type { Role } from "./auth.js";

/**
 * 感測器 token 發放／撤銷（管理平面，僅 platform_admin）。
 * - 明文 token 只在發放回應出現一次；DB 只存 argon2 雜湊。
 * - 撤銷只標 revoked_at，列不刪，sensor_id 永久保留供舊資料對應。
 */
const ADMIN: Role[] = ["platform_admin"];
const MAX_LABEL = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type IssueBody = { label?: unknown } | null | undefined;
type ListRow = { sensor_id: string; created_at: string; revoked_at: string | null; label: string | null };

/** 256 bit 隨機，base64url；前綴便於外洩掃描辨識。 */
export function newSensorToken(): string {
  return `sdst_${randomBytes(32).toString("base64url")}`;
}

function parseLabel(body: IssueBody): { ok: true; label: string | null } | { ok: false } {
  if (body === null || body === undefined) return { ok: true, label: null };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false };
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "label")) return { ok: false };
  if (body.label === undefined) return { ok: true, label: null };
  if (typeof body.label !== "string" || body.label.length > MAX_LABEL) return { ok: false };
  return { ok: true, label: body.label };
}

export function registerSensorTokenRoutes(
  app: FastifyInstance, db: Db, now: () => number,
): void {
  app.post<{ Body: IssueBody }>("/api/sensors/tokens", { config: { roles: ADMIN } },
    async (req, reply) => {
      const parsed = parseLabel(req.body);
      if (!parsed.ok) return reply.code(400).send({ error: "請求格式錯誤" });
      const sensorId = randomUUID();
      const token = newSensorToken();
      await db.query(
        `INSERT INTO sensor_tokens (sensor_id, token_hash, created_by, created_at, label)
         VALUES ($1,$2,$3,$4,$5)`,
        [sensorId, await argon2.hash(token), req.user!.id, now(), parsed.label],
      );
      reply.header("cache-control", "no-store");
      return reply.code(201).send({ sensor_id: sensorId, token });
    });

  app.get("/api/sensors/tokens", { config: { roles: ADMIN } }, async () => {
    const r = await db.query<ListRow>(
      `SELECT sensor_id, created_at, revoked_at, label FROM sensor_tokens
       ORDER BY created_at, sensor_id`,
    );
    return {
      items: r.rows.map((x) => ({
        sensor_id: x.sensor_id,
        created_at: Number(x.created_at),
        revoked_at: x.revoked_at === null ? null : Number(x.revoked_at),
        label: x.label,
      })),
    };
  });

  app.post<{ Params: { sensorId: string } }>("/api/sensors/tokens/:sensorId/revoke",
    { config: { roles: ADMIN } },
    async (req, reply) => {
      const id = req.params.sensorId;
      if (!UUID_RE.test(id)) return reply.code(404).send({ error: "查無感測器" });
      const r = await db.query<{ sensor_id: string }>(
        `UPDATE sensor_tokens SET revoked_at = COALESCE(revoked_at, $2)
         WHERE sensor_id = $1 RETURNING sensor_id`,
        [id, now()],
      );
      if (!r.rows[0]) return reply.code(404).send({ error: "查無感測器" });
      return reply.code(204).send();
    });
}
