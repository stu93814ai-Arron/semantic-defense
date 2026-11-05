import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { assertAllowlistCidr, Id } from "@semantic-defense/contracts";
import { sha256 } from "@semantic-defense/sensor-auth";
import type { Db } from "./db.js";
import { writeAudit } from "./audit.js";
import type { Role } from "./auth.js";

/**
 * 感測器 token 發放／撤銷（管理平面，僅 platform_admin）。
 * - 格式 `sdst_<sensor_id>.<secret>`；secret 為 256 bit 隨機 base64url。
 * - 查找（findSensorByToken）已移至 @semantic-defense/sensor-auth，供 sensor-ingest 共用。
 * - 明文只在發放回應出現一次；DB 只存 secret 的 SHA-256 hex。
 * - 必填 allowed_cidrs（≥1，contracts 白名單規則）與 allowed_app_ids（≥1，contracts Id）。
 * - 發放與修改 app 綁定寫入 audit_events（不含 token／secret／hash）。
 * - 撤銷只標 revoked_at，列不刪，sensor_id 永久保留。
 */
const ADMIN: Role[] = ["platform_admin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CIDRS = 64;
const MAX_APPS = 64;

type ListRow = {
  sensor_id: string; created_at: string; revoked_at: string | null; allowed_cidrs: string[]; allowed_app_ids: string[];
};

export function newSensorToken(sensorId: string): { token: string; secret: string } {
  const secret = randomBytes(32).toString("base64url");
  return { token: `sdst_${sensorId}.${secret}`, secret };
}

const isObj = (b: unknown): b is Record<string, unknown> =>
  b !== null && typeof b === "object" && !Array.isArray(b);

function parseAppIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_APPS) return null;
  return v.every((x) => Id.safeParse(x).success) ? (v as string[]) : null;
}

function parseCidrs(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CIDRS) return null;
  return v.every((c) => typeof c === "string" && assertAllowlistCidr(c)) ? (v as string[]) : null;
}

function parseIssue(body: unknown): { cidrs: string[]; apps: string[] } | null {
  if (!isObj(body)) return null;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "allowed_app_ids" || keys[1] !== "allowed_cidrs") return null;
  const cidrs = parseCidrs(body.allowed_cidrs);
  const apps = parseAppIds(body.allowed_app_ids);
  return cidrs && apps ? { cidrs, apps } : null;
}

function parsePatchApps(body: unknown): string[] | null {
  if (!isObj(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "allowed_app_ids") return null;
  return parseAppIds(body.allowed_app_ids);
}

export function registerSensorTokenRoutes(
  app: FastifyInstance, db: Db, now: () => number,
): void {
  app.post("/api/sensors/tokens", { config: { roles: ADMIN } },
    async (req, reply) => {
      const parsed = parseIssue(req.body);
      if (!parsed) return reply.code(400).send({ error: "請求格式錯誤" });
      const sensorId = randomUUID();
      const { token, secret } = newSensorToken(sensorId);
      await db.query(
        `INSERT INTO sensor_tokens (sensor_id, token_hash, created_by, created_at, allowed_cidrs, allowed_app_ids)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sensorId, sha256(secret).toString("hex"), req.user!.id, now(), parsed.cidrs, parsed.apps],
      );
      await writeAudit(db, { action: "sensor_token.issue", actor: req.user!.username, sensor_id: sensorId, at: now(),
        detail: { allowed_cidrs: parsed.cidrs, allowed_app_ids: parsed.apps } });
      reply.header("cache-control", "no-store");
      return reply.code(201).send({ sensor_id: sensorId, token });
    });

  app.get("/api/sensors/tokens", { config: { roles: ADMIN } }, async () => {
    const r = await db.query<ListRow>(
      `SELECT sensor_id, created_at, revoked_at, allowed_cidrs, allowed_app_ids FROM sensor_tokens
       ORDER BY created_at, sensor_id`,
    );
    return {
      items: r.rows.map((x) => ({
        sensor_id: x.sensor_id,
        created_at: Number(x.created_at),
        revoked_at: x.revoked_at === null ? null : Number(x.revoked_at),
        allowed_cidrs: x.allowed_cidrs,
        allowed_app_ids: x.allowed_app_ids,
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

  app.patch<{ Params: { sensorId: string } }>("/api/sensors/tokens/:sensorId/apps",
    { config: { roles: ADMIN } },
    async (req, reply) => {
      const id = req.params.sensorId;
      if (!UUID_RE.test(id)) return reply.code(404).send({ error: "查無感測器" });
      const apps = parsePatchApps(req.body);
      if (!apps) return reply.code(400).send({ error: "請求格式錯誤" });
      const r = await db.query<{ sensor_id: string }>(
        "UPDATE sensor_tokens SET allowed_app_ids = $2 WHERE sensor_id = $1 RETURNING sensor_id", [id, apps],
      );
      if (!r.rows[0]) return reply.code(404).send({ error: "查無感測器" });
      await writeAudit(db, { action: "sensor_token.update_apps", actor: req.user!.username, sensor_id: id, at: now(),
        detail: { allowed_app_ids: apps } });
      return { sensor_id: id, allowed_app_ids: apps };
    });
}
