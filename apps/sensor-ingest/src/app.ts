import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { parseFlowMetadataEvent } from "@semantic-defense/contracts";
import { findSensorByToken, ipAllowed, type SensorDb } from "@semantic-defense/sensor-auth";
import { createAuthFailLimiter } from "./rate-limit.js";
import { ensureFlowSchema, insertFlow, purgeExpired, recordRejection } from "./store.js";

/**
 * sensor-ingest（流量平面）③b：認證面。
 * - HTTPS 必修：預設 requireHttps=true，以 req.protocol（= socket.encrypted；不信任 proxy，x-forwarded-proto 無效）判定，明文 → 426。
 *   生產以 `https: { key, cert }` 直接終結 TLS；requireHttps:false 只給測試以 inject 驗認證邏輯。
 * - 認證：Authorization: Bearer sdst_<sensor_id>.<secret> → 401；來源 IP（socket，不讀 X-Forwarded-For）不在 allowed_cidrs → 403。
 * - 未授權 IP 速率限制：先驗 Bearer；有效 token 不查也不計限流。缺／錯 token 才依來源 IP 查限流並計失敗，約 30／60s → 429（不讀 XFF；403／成功不計；注入時鐘）。
 * - 無 session、無管理／登入路由；未宣告路徑一律 404（認證掛在路由 onRequest：先於 body 解析，未認證請求不解析 body；不影響 404）。
 * - ③c：POST /v1/flows body＝單一 FlowMetadataEvent（contracts strict 驗證），sensor_id 取自 token → 201；
 *   自報 sensor_id／非法 → 400；app_id 不在 token 的 allowed_app_ids → 403（只記 sensor_id＋時間）；同 sensor 重複 flow_id → 409。寫入前清除 ≥7 天列（見 store.ts）。
 */
export type BuildIngestOptions = {
  db: SensorDb;
  https?: { key: string | Buffer; cert: string | Buffer };
  requireHttps?: boolean;
  /** 注入時鐘（epoch ms），預設 Date.now。 */
  now?: () => number;
  /** 未授權失敗計數 Map 上限（預設 AUTH_FAIL_MAX_KEYS；測試可注入小值）。 */
  authFailMaxKeys?: number;
};

declare module "fastify" {
  interface FastifyRequest { sensorId?: string; allowedAppIds?: string[] }
}

/** DoS 面：body 上限 256KB，超過 → 413。 */
export const BODY_LIMIT = 256 * 1024;

const BEARER = /^Bearer (\S+)$/;

function makeGuard(
  db: SensorDb,
  requireHttps: boolean,
  now: () => number,
  limiter: ReturnType<typeof createAuthFailLimiter>,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (requireHttps && req.protocol !== "https") {
      return void reply.code(426).header("upgrade", "TLS/1.3").send({ error: "需要 HTTPS" });
    }
    const ip = req.socket.remoteAddress ?? req.ip;
    // 先驗 Bearer：有效 token 不查、不計來源限流（避免攻擊者封鎖同 IP／同 /64 的合法感測器）。
    const m = BEARER.exec(req.headers.authorization ?? "");
    const sensor = m ? await findSensorByToken(db, m[1]!) : null;
    if (!sensor) {
      if (limiter.check(ip, now()) === "limited") {
        return void reply.code(429).send({ error: "請求過於頻繁" });
      }
      limiter.recordFail(ip, now());
      return void reply.code(401).send({ error: "未授權" });
    }
    if (!ipAllowed(ip, sensor.allowed_cidrs)) {
      return void reply.code(403).send({ error: "來源 IP 不在允許清單" });
    }
    req.sensorId = sensor.sensor_id;
    req.allowedAppIds = sensor.allowed_app_ids;
  };
}

const hasSelfReportedSensorId = (body: unknown): boolean =>
  body !== null && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "sensor_id");

export async function buildIngest(opts: BuildIngestOptions): Promise<FastifyInstance> {
  const app = (opts.https
    ? Fastify({ https: opts.https, trustProxy: false, bodyLimit: BODY_LIMIT })
    : Fastify({ trustProxy: false, bodyLimit: BODY_LIMIT })) as unknown as FastifyInstance;
  const clock = opts.now ?? Date.now;
  await ensureFlowSchema(opts.db);
  const limiter = createAuthFailLimiter({ maxKeys: opts.authFailMaxKeys });
  const guard = makeGuard(opts.db, opts.requireHttps ?? true, clock, limiter);

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "查無此路徑" }));

  app.get("/v1/health", { onRequest: guard }, async (req) => ({ ok: true, sensor_id: req.sensorId }));

  app.post("/v1/flows", { onRequest: guard }, async (req, reply) => {
    if (hasSelfReportedSensorId(req.body)) {
      return reply.code(400).send({ error: "sensor_id 由 token 決定，不得自報" });
    }
    const parsed = parseFlowMetadataEvent(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "請求格式錯誤", issues: parsed.errors });
    const now = clock();
    if (!req.allowedAppIds!.includes(parsed.value.app_id)) {
      await recordRejection(opts.db, req.sensorId!, now);
      return reply.code(403).send({ error: "app_id 未綁定此感測器" });
    }
    await purgeExpired(opts.db, now);
    if (!(await insertFlow(opts.db, parsed.value, req.sensorId!, now))) {
      return reply.code(409).send({ error: "flow_id 重複" });
    }
    return reply.code(201).send({ flow_id: parsed.value.flow_id });
  });

  await app.ready();
  return app;
}
