import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { deny, loadSession, readCookie } from "./auth.js";

/** 集中式授權：預設拒絕；路由須宣告 roles（public／any／角色清單）。 */
export function createAuthPreHandler(db: Db, idleTimeoutMs: number) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const roles = req.routeOptions.config?.roles;
    if (roles === "public") return;
    const sid = readCookie(req);
    const user = sid ? await loadSession(db, sid, idleTimeoutMs) : undefined;
    if (!user) {
      deny(reply, 401);
      return;
    }
    req.user = user;
    if (roles === "any") return;
    if (!roles || !roles.includes(user.role)) deny(reply, 403);
  };
}
