import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { deny, loadSession, readCookie, type Clock } from "./auth.js";

/**
 * 集中式授權：
 * - request.is404 → 放行，交給 notFoundHandler 回 404
 * - roles === "public" → 放行
 * - 已掛路由（含 roles 未宣告）→ fail closed：無 session 401、有 session 但角色不符／缺 roles → 403
 */
export function createAuthPreHandler(
  db: Db,
  idleTimeoutMs: number,
  now: Clock = Date.now,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (req.is404) return;
    const roles = req.routeOptions.config?.roles;
    if (roles === "public") return;
    const sid = readCookie(req);
    const user = sid ? await loadSession(db, sid, idleTimeoutMs, now) : undefined;
    if (!user) {
      deny(reply, 401);
      return;
    }
    req.user = user;
    if (roles === "any") return;
    if (Array.isArray(roles) && roles.includes(user.role)) return;
    deny(reply, 403);
  };
}
