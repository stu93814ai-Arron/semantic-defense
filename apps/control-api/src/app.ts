import Fastify, {
  type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions,
} from "fastify";
import argon2 from "argon2";
import { openDb, resolveDatabaseUrl, type Db } from "./db.js";
import {
  LOGIN_ERROR, LoginLimiter, getDummyHash, newSessionId, readCookie, sessionCookie,
  type Role,
} from "./auth.js";
import { createAuthPreHandler } from "./authz.js";
import { registerSensorTokenRoutes } from "./sensor-tokens.js";
import { registerAuditRoute } from "./audit.js";
import { registerThresholdRoutes } from "./thresholds.js";
import { registerWhitelistRoutes } from "./whitelist.js";
import { registerBlacklistRoutes } from "./blacklist.js";
import { badJsonError, installErrorHandler, safeErr, withSafeReqLog } from "./errors.js";
import { runJudgeTick, type TickOpts } from "./judge.js";
import { assertWebhookSecret, deliverDueAlerts, enabledAlertChannels, type AlertChannel, type AlertSender } from "./alert-outbox.js";

export type BuildAppOptions = {
  idleTimeoutMs?: number;
  loginRateLimit?: { maxFailures: number; windowMs: number };
  /** 僅在可信反向代理後方開啟；預設 false，避免偽造 X-Forwarded-For 繞過速率限制。 */
  trustProxy?: boolean;
  /** Postgres 連線；省略則讀 DATABASE_URL。兩者皆無則啟動失敗。 */
  databaseUrl?: string;
  /** 可選時鐘（epoch ms）；省略則 Date.now。 */
  now?: () => number;
  /** 僅綁管理平面 listen；port 0 = 系統指派。不得另開流量 listener。 */
  management?: { host: string; port: number };
  /** Fastify logger 設定（可注入 stream 等）；省略＝Fastify 預設 logger（true）。預設 req 序列化不含 headers／body。 */
  logger?: FastifyServerOptions["logger"];
  /** 判定 tick 間隔（ms）；預設 5000，0＝關閉（測試直接呼叫 runJudgeTick）。 */
  judgeIntervalMs?: number;
  /** E3.A 熔斷上限 N：滑動 1 小時內 source=auto 最多 N 筆（正整數，預設 50；計畫 §6.3，這一刀不做管理頁）。 */
  autoBreakerPerHour?: number;
  /** E3.A 自動上榜總開關；省略＝AUTO_LIST_ENABLED_DEFAULT（false，關）。關時判定 tick 只開案、不自動上榜。 */
  autoListEnabled?: boolean;
  /** 測試用：ready／listen 前掛額外路由（例如無 roles 探針）。 */
  beforeReady?: (app: ControlApi) => void | Promise<void>;
  /** 告警推送間隔（ms）；預設 1000，0＝關閉（測試直接呼叫 deliverDueAlerts）。 */
  alertDeliverIntervalMs?: number;
  /** 已啟用的告警通道；省略則依環境變數。 */
  alertChannels?: readonly AlertChannel[];
  /** 測試用發送器（未實作的通道不發送、不耗次數）。 */
  alertSenders?: Partial<Record<AlertChannel, AlertSender>>;
};

export type ControlApi = FastifyInstance;

export type AuthRouteAuditEntry = {
  method: string;
  url: string;
  roles: Role[] | "public" | "any" | undefined;
};

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    /** onRoute 收集的已掛路由 roles 稽核表（測試用）。 */
    authRouteAudit: AuthRouteAuditEntry[];
  }
  interface FastifyRequest { user?: import("./auth.js").SessionUser }
  interface FastifyContextConfig { roles?: Role[] | "public" | "any" }
}

type LoginBody = { username?: unknown; password?: unknown };
type Clock = () => number;

async function verifyCredentials(
  db: Db, username: string, password: string,
): Promise<number | undefined> {
  const r = await db.query<{ id: number; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE username = $1", [username],
  );
  const row = r.rows[0];
  const hash = row?.password_hash ?? (await getDummyHash());
  const ok = (await argon2.verify(hash, password).catch(() => false)) && !!row;
  return ok ? row!.id : undefined;
}

async function issueSession(
  db: Db, req: FastifyRequest, reply: FastifyReply,
  userId: number, now: Clock,
): Promise<{ ok: true }> {
  const old = readCookie(req);
  if (old) await db.query("DELETE FROM sessions WHERE id = $1", [old]);
  const sid = newSessionId();
  await db.query(
    "INSERT INTO sessions (id, user_id, last_seen) VALUES ($1,$2,$3)",
    [sid, userId, now()],
  );
  reply.header("set-cookie", sessionCookie(sid));
  return { ok: true };
}

function registerLogin(
  app: ControlApi, db: Db, limiter: LoginLimiter, now: Clock,
): void {
  app.post<{ Body: LoginBody }>(
    "/api/session/login",
    { config: { roles: "public" } },
    async (req, reply) => {
      const username = typeof req.body?.username === "string" ? req.body.username : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (await limiter.blocked(username, req.ip)) {
        return reply.code(429).send({ error: `${LOGIN_ERROR}，請稍後再試` });
      }
      const userId = await verifyCredentials(db, username, password);
      if (userId === undefined) {
        await limiter.fail(username, req.ip);
        return reply.code(401).send({ error: LOGIN_ERROR });
      }
      await limiter.reset(username, req.ip);
      return issueSession(db, req, reply, userId, now);
    },
  );
}

function registerSessionRoutes(app: ControlApi, db: Db): void {
  app.post("/api/session/logout", { config: { roles: "any" } }, async (req, reply) => {
    await db.query("DELETE FROM sessions WHERE id = $1", [readCookie(req)]);
    reply.header("set-cookie", sessionCookie("", 0));
    return { ok: true };
  });
  app.get("/api/session/me", { config: { roles: "any" } }, async (req) => {
    const { username, role } = req.user!;
    return { username, role };
  });
}

function registerRoleRoutes(app: ControlApi): void {
  const empty = async () => ({ items: [] });
  const op: Role[] = ["operator"];
  const admin: Role[] = ["platform_admin"];
  for (const url of ["/api/judgments", "/api/judgments/history", "/api/constraints"]) {
    app.get(url, { config: { roles: op } }, empty);
  }
  app.get("/api/judgments/:caseId", { config: { roles: op } }, async (_req, reply) =>
    reply.code(404).send({ error: "查無案件" }));
  for (const url of ["/api/admin/users", "/api/versions"]) {
    app.get(url, { config: { roles: admin } }, empty);
  }
  app.get("/api/health", { config: { roles: admin } }, async () => ({ status: "ok" }));
}

function registerOwnerRoutes(app: ControlApi, db: Db): void {
  const ownApp = async (appId: string, userId: number) =>
    (await db.query<{ id: string }>(
      "SELECT id FROM apps WHERE id = $1 AND owner_id = $2", [appId, userId],
    )).rows[0];
  const owner: Role[] = ["app_owner"];
  app.get<{ Params: { appId: string } }>("/api/apps/:appId", { config: { roles: owner } },
    async (req, reply) => {
      const a = await ownApp(req.params.appId, req.user!.id);
      return a ? { id: a.id } : reply.code(404).send({ error: "查無應用" });
    });
  app.get<{ Params: { appId: string } }>("/api/apps/:appId/map", { config: { roles: owner } },
    async (req, reply) => {
      const a = await ownApp(req.params.appId, req.user!.id);
      return a ? { appId: a.id, items: [] } : reply.code(404).send({ error: "查無應用" });
    });
}


/** 允許空 body 的 JSON parser，避免未掛載 POST+application/json 先被解析成 400。 */
function allowEmptyJson(app: ControlApi): void {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      const raw = typeof body === "string" ? body : "";
      if (raw.length === 0) {
        done(null, null);
        return;
      }
      try {
        done(null, JSON.parse(raw) as unknown);
      } catch {
        // 不帶 parser 原文；錯誤處理以 400 固定 body 回應
        done(badJsonError(), undefined);
      }
    },
  );
}


/** onRoute 收集已掛路由的 method／url／roles，供稽核測試斷言。 */
function installRouteAudit(app: ControlApi): void {
  const audit: AuthRouteAuditEntry[] = [];
  app.decorate("authRouteAudit", audit);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD") continue;
      audit.push({
        method,
        url: route.url,
        roles: route.config?.roles,
      });
    }
  });
}

/** 熔斷上限必須是正整數（A 組領航員裁定）：0、負數、小數、NaN、Infinity 在啟動時就拋錯，不開 DB。 */
function assertBreakerLimit(n: number | undefined): void {
  if (n !== undefined && !(Number.isSafeInteger(n) && n > 0)) throw new Error("autoBreakerPerHour 必須是正整數");
}

/** 定期跑判定 tick（同一實例不重疊）；回傳的 stop 清 timer 並等進行中的 tick 結束。 */
function startJudgeTimer(app: ControlApi, db: Db, now: Clock, ms: number, opts: TickOpts): () => Promise<void> {
  if (ms <= 0) return async () => {};
  let inflight: Promise<unknown> | undefined;
  const t = setInterval(() => {
    inflight ??= runJudgeTick(db, now(), app.log, opts)
      .catch((err: unknown) => app.log.error({ err: safeErr(err as Parameters<typeof safeErr>[0]) }, "judge tick failed"))
      .finally(() => { inflight = undefined; });
  }, ms);
  return async () => { clearInterval(t); await inflight; };
}

/** 定期發送到期 outbox（同一實例不重疊）；發送在交易外。 */
function startAlertTimer(app: ControlApi, db: Db, now: Clock, ms: number, senders: Partial<Record<AlertChannel, AlertSender>>): () => Promise<void> {
  if (ms <= 0) return async () => {};
  let inflight: Promise<unknown> | undefined;
  const t = setInterval(() => {
    inflight ??= deliverDueAlerts(db, now(), senders, app.log)
      .catch((err: unknown) => app.log.error({ err: safeErr(err as Parameters<typeof safeErr>[0]) }, "alert delivery failed"))
      .finally(() => { inflight = undefined; });
  }, ms);
  return async () => { clearInterval(t); await inflight; };
}

async function readyOrListen(app: ControlApi, opts: BuildAppOptions): Promise<void> {
  if (opts.beforeReady) await opts.beforeReady(app);
  if (opts.management) await app.listen({ host: opts.management.host, port: opts.management.port });
  else await app.ready();
}

function hookTimers(app: ControlApi, db: Db, now: Clock, opts: BuildAppOptions): void {
  const alertChannels = enabledAlertChannels(process.env, opts.alertChannels);
  const stopJudge = startJudgeTimer(app, db, now, opts.judgeIntervalMs ?? 5000, { autoBreakerPerHour: opts.autoBreakerPerHour, autoListEnabled: opts.autoListEnabled, alertChannels });
  const stopAlert = startAlertTimer(app, db, now, opts.alertDeliverIntervalMs ?? 1000, opts.alertSenders ?? {});
  app.addHook("onClose", async () => { await stopJudge(); await stopAlert(); await db.close(); });
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<ControlApi> {
  assertBreakerLimit(opts.autoBreakerPerHour);
  assertWebhookSecret(process.env);
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
  const rl = opts.loginRateLimit ?? { maxFailures: 5, windowMs: 60_000 };
  const now = opts.now ?? Date.now;
  const app = Fastify({ trustProxy: opts.trustProxy ?? false, logger: withSafeReqLog(opts.logger) });
  try {
    const db = await openDb(resolveDatabaseUrl(opts.databaseUrl), { now, log: app.log });
    const limiter = new LoginLimiter(db, rl.maxFailures, rl.windowMs, now);
    installErrorHandler(app);
    allowEmptyJson(app);
    app.decorate("db", db);
    installRouteAudit(app);
    hookTimers(app, db, now, opts);
    app.addHook("preHandler", createAuthPreHandler(db, idleTimeoutMs, now));
    registerLogin(app, db, limiter, now);
    registerSessionRoutes(app, db);
    registerRoleRoutes(app);
    registerOwnerRoutes(app, db);
    registerSensorTokenRoutes(app, db, now);
    registerAuditRoute(app, db);
    registerThresholdRoutes(app, db, now);
    registerWhitelistRoutes(app, db, now);
    registerBlacklistRoutes(app, db, now);
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not Found" }));
    await readyOrListen(app, opts);
    return app;
  } catch (err) {
    await app.close();
    throw err;
  }
}

/** 再匯出測試用 seed；實作與明碼密碼在 seed-phase2.ts（生產勿呼叫）。 */
export { seedPhase2Fixtures } from "./seed-phase2.js";
