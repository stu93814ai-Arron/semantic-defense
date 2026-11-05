import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import argon2 from "argon2";
import { openDb, type Db } from "./db.js";
import {
  LOGIN_ERROR, LoginLimiter, getDummyHash, newSessionId, readCookie, sessionCookie,
  type Role,
} from "./auth.js";
import { createAuthPreHandler } from "./authz.js";

export type BuildAppOptions = {
  idleTimeoutMs?: number;
  loginRateLimit?: { maxFailures: number; windowMs: number };
  /** 僅在可信反向代理後方開啟；預設 false，避免偽造 X-Forwarded-For 繞過速率限制。 */
  trustProxy?: boolean;
};
export type ControlApi = FastifyInstance;

declare module "fastify" {
  interface FastifyInstance { db: Db }
  interface FastifyRequest { user?: import("./auth.js").SessionUser }
  interface FastifyContextConfig { roles?: Role[] | "public" | "any" }
}

type LoginBody = { username?: unknown; password?: unknown };

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
  db: Db, req: FastifyRequest, reply: FastifyReply, userId: number,
): Promise<{ ok: true }> {
  const old = readCookie(req);
  if (old) await db.query("DELETE FROM sessions WHERE id = $1", [old]);
  const sid = newSessionId();
  await db.query(
    "INSERT INTO sessions (id, user_id, last_seen) VALUES ($1,$2,$3)",
    [sid, userId, Date.now()],
  );
  reply.header("set-cookie", sessionCookie(sid));
  return { ok: true };
}

function registerLogin(
  app: ControlApi, db: Db, limiter: LoginLimiter,
): void {
  app.post<{ Body: LoginBody }>(
    "/api/session/login",
    { config: { roles: "public" } },
    async (req, reply) => {
      const username = typeof req.body?.username === "string" ? req.body.username : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (limiter.blocked(username, req.ip)) {
        return reply.code(429).send({ error: `${LOGIN_ERROR}，請稍後再試` });
      }
      const userId = await verifyCredentials(db, username, password);
      if (userId === undefined) {
        limiter.fail(username, req.ip);
        return reply.code(401).send({ error: LOGIN_ERROR });
      }
      limiter.reset(username, req.ip);
      return issueSession(db, req, reply, userId);
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
  for (const url of ["/api/admin/users", "/api/audit", "/api/versions"]) {
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

export async function buildApp(opts: BuildAppOptions = {}): Promise<ControlApi> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
  const rl = opts.loginRateLimit ?? { maxFailures: 5, windowMs: 60_000 };
  const limiter = new LoginLimiter(rl.maxFailures, rl.windowMs);
  const db = await openDb();
  const app = Fastify({ trustProxy: opts.trustProxy ?? false });
  app.decorate("db", db);
  app.addHook("onClose", async () => { await db.close(); });
  app.addHook("preHandler", createAuthPreHandler(db, idleTimeoutMs));
  registerLogin(app, db, limiter);
  registerSessionRoutes(app, db);
  registerRoleRoutes(app);
  registerOwnerRoutes(app, db);
  await app.ready();
  return app;
}

/** 再匯出測試用 seed；實作與明碼密碼在 seed-phase2.ts（生產勿呼叫）。 */
export { seedPhase2Fixtures } from "./seed-phase2.js";
