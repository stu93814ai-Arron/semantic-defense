import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

export type Role = "operator" | "app_owner" | "platform_admin";
export type SessionUser = { id: number; username: string; role: Role };

export const COOKIE = "sd_session";
export const LOGIN_ERROR = "帳號或密碼錯誤";

// 未知帳號仍做一次 argon2 驗證，避免時間差洩漏帳號存在
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash(randomBytes(16).toString("hex"));
  return dummyHash;
}

export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export function readCookie(req: FastifyRequest): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

export function sessionCookie(id: string, maxAgeSec?: number): string {
  const age = maxAgeSec === undefined ? "" : `; Max-Age=${maxAgeSec}`;
  return `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict${age}`;
}

/** 依 last_seen 驗證 session，有效則更新 last_seen（滑動閒置逾時）。 */
export async function loadSession(
  db: Db,
  sid: string,
  idleTimeoutMs: number,
): Promise<SessionUser | undefined> {
  const now = Date.now();
  const r = await db.query<SessionUser & { last_seen: string }>(
    `SELECT u.id, u.username, u.role, s.last_seen FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [sid],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  if (now - Number(row.last_seen) > idleTimeoutMs) {
    await db.query("DELETE FROM sessions WHERE id = $1", [sid]);
    return undefined;
  }
  await db.query("UPDATE sessions SET last_seen = $1 WHERE id = $2", [now, sid]);
  return { id: row.id, username: row.username, role: row.role };
}

/** 登入失敗計數：鍵為 username + 來源位址；帳號不存在同樣計數。 */
export class LoginLimiter {
  private hits = new Map<string, number[]>();
  constructor(private maxFailures: number, private windowMs: number) {}
  private key(u: string, ip: string): string {
    return `${u}\u0000${ip}`;
  }
  private recent(k: string): number[] {
    const cut = Date.now() - this.windowMs;
    const list = (this.hits.get(k) ?? []).filter((t) => t > cut);
    this.hits.set(k, list);
    return list;
  }
  blocked(u: string, ip: string): boolean {
    return this.recent(this.key(u, ip)).length >= this.maxFailures;
  }
  fail(u: string, ip: string): void {
    this.recent(this.key(u, ip)).push(Date.now());
  }
  reset(u: string, ip: string): void {
    this.hits.delete(this.key(u, ip));
  }
}

export function deny(reply: FastifyReply, code: 401 | 403): FastifyReply {
  return reply.code(code).send({ error: code === 401 ? "未登入" : "權限不足" });
}
