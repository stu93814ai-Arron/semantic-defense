import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { findSensorByToken, ipAllowed, type SensorDb } from "@semantic-defense/sensor-auth";

/**
 * sensor-ingest（流量平面）③b：認證面。
 * - HTTPS 必修：預設 requireHttps=true，以 req.protocol（= socket.encrypted；不信任 proxy，x-forwarded-proto 無效）判定，明文 → 426。
 *   生產以 `https: { key, cert }` 直接終結 TLS；requireHttps:false 只給測試以 inject 驗認證邏輯。
 * - 認證：Authorization: Bearer sdst_<sensor_id>.<secret> → 401；來源 IP（socket，不讀 X-Forwarded-For）不在 allowed_cidrs → 403。
 * - 無 session、無管理／登入路由；未宣告路徑一律 404（認證掛在路由 preHandler，不影響 404）。
 * - 存入（FlowMetadata）屬 ③c，本階段 POST /v1/flows 只驗認證與拒自報 sensor_id，回 501。
 */
export type BuildIngestOptions = {
  db: SensorDb;
  https?: { key: string | Buffer; cert: string | Buffer };
  requireHttps?: boolean;
};

declare module "fastify" {
  interface FastifyRequest { sensorId?: string }
}

const BEARER = /^Bearer (\S+)$/;

function makeGuard(db: SensorDb, requireHttps: boolean) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (requireHttps && req.protocol !== "https") {
      return void reply.code(426).header("upgrade", "TLS/1.3").send({ error: "需要 HTTPS" });
    }
    const m = BEARER.exec(req.headers.authorization ?? "");
    const sensor = m ? await findSensorByToken(db, m[1]!) : null;
    if (!sensor) return void reply.code(401).send({ error: "未授權" });
    if (!ipAllowed(req.socket.remoteAddress ?? req.ip, sensor.allowed_cidrs)) {
      return void reply.code(403).send({ error: "來源 IP 不在允許清單" });
    }
    req.sensorId = sensor.sensor_id;
  };
}

const hasSelfReportedSensorId = (body: unknown): boolean =>
  body !== null && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "sensor_id");

export async function buildIngest(opts: BuildIngestOptions): Promise<FastifyInstance> {
  const app = (opts.https
    ? Fastify({ https: opts.https, trustProxy: false })
    : Fastify({ trustProxy: false })) as unknown as FastifyInstance;
  const guard = makeGuard(opts.db, opts.requireHttps ?? true);

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "查無此路徑" }));

  app.get("/v1/health", { preHandler: guard }, async (req) => ({ ok: true, sensor_id: req.sensorId }));

  app.post("/v1/flows", { preHandler: guard }, async (req, reply) => {
    if (hasSelfReportedSensorId(req.body)) {
      return reply.code(400).send({ error: "sensor_id 由 token 決定，不得自報" });
    }
    return reply.code(501).send({ error: "存入尚未實作（③c）" });
  });

  await app.ready();
  return app;
}
