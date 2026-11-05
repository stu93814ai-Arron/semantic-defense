import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { deny, loadSession, readCookie, type Clock } from "./auth.js";

/**
 * 集中式授權：預設拒絕已掛載路由。
 * - 未宣告 roles（未掛載路徑）→ 不在此處理，交 404
 * - public → 放行；any／角色清單 → 未登入 401、角色不符 403
 */
export function createAuthPreHandler(
  db: Db,
  idleTimeoutMs: number,
  now: Clock = Date.now,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const roles = req.routeOptions.config?.roles;
    if (roles === undefined) return;
    if (roles === "public") return;
    const sid = readCookie(req);
    const user = sid ? await loadSession(db, sid, idleTimeoutMs, now) : undefined;
    if (!user) {
      deny(reply, 401);
      return;
    }
    req.user = user;
    if (roles === "any") return;
    if (!roles.includes(user.role)) deny(reply, 403);
  };
}
