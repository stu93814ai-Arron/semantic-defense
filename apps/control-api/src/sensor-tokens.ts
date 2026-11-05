import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { assertAllowlistCidr } from "@semantic-defense/contracts";
import { sha256 } from "@semantic-defense/sensor-auth";
import type { Db } from "./db.js";
import type { Role } from "./auth.js";

/**
 * 感測器 token 發放／撤銷（管理平面，僅 platform_admin）。
 * - 格式 `sdst_<sensor_id>.<secret>`；secret 為 256 bit 隨機 base64url。
 * - 查找（findSensorByToken）已移至 @semantic-defense/sensor-auth，供 sensor-ingest 共用。
 * - 明文只在發放回應出現一次；DB 只存 secret 的 SHA-256 hex。
 * - 必填 allowed_cidrs（≥1，contracts 白名單規則）；③b 負責強制執行。
 * - 撤銷只標 revoked_at，列不刪，sensor_id 永久保留。
 */
const ADMIN: Role[] = ["platform_admin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CIDRS = 64;

type ListRow = { sensor_id: string; created_at: string; revoked_at: string | null; allowed_cidrs: string[] };

export function newSensorToken(sensorId: string): { token: string; secret: string } {
  const secret = randomBytes(32).toString("base64url");
  return { token: `sdst_${sensorId}.${secret}`, secret };
}

function parseIssue(body: unknown): string[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "allowed_cidrs") return null;
  const v = (body as { allowed_cidrs: unknown }).allowed_cidrs;
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CIDRS) return null;
  if (!v.every((c) => typeof c === "string" && assertAllowlistCidr(c))) return null;
  return v as string[];
}

export function registerSensorTokenRoutes(
  app: FastifyInstance, db: Db, now: () => number,
): void {
  app.post("/api/sensors/tokens", { config: { roles: ADMIN } },
    async (req, reply) => {
      const cidrs = parseIssue(req.body);
      if (!cidrs) return reply.code(400).send({ error: "請求格式錯誤" });
      const sensorId = randomUUID();
      const { token, secret } = newSensorToken(sensorId);
      await db.query(
        `INSERT INTO sensor_tokens (sensor_id, token_hash, created_by, created_at, allowed_cidrs)
         VALUES ($1,$2,$3,$4,$5)`,
        [sensorId, sha256(secret).toString("hex"), req.user!.id, now(), cidrs],
      );
      reply.header("cache-control", "no-store");
      return reply.code(201).send({ sensor_id: sensorId, token });
    });

  app.get("/api/sensors/tokens", { config: { roles: ADMIN } }, async () => {
    const r = await db.query<ListRow>(
      `SELECT sensor_id, created_at, revoked_at, allowed_cidrs FROM sensor_tokens
       ORDER BY created_at, sensor_id`,
    );
    return {
      items: r.rows.map((x) => ({
        sensor_id: x.sensor_id,
        created_at: Number(x.created_at),
        revoked_at: x.revoked_at === null ? null : Number(x.revoked_at),
        allowed_cidrs: x.allowed_cidrs,
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
