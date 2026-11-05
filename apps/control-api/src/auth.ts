import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

export type Role = "operator" | "app_owner" | "platform_admin";
export type SessionUser = { id: number; username: string; role: Role };
export type Clock = () => number;

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

/** 依 last_seen 驗證 session；有效則用注入時鐘更新 last_seen（滑動閒置）。 */
export async function loadSession(
  db: Db,
  sid: string,
  idleTimeoutMs: number,
  now: Clock = Date.now,
): Promise<SessionUser | undefined> {
  const t = now();
  const r = await db.query<SessionUser & { last_seen: string | number }>(
    `SELECT u.id, u.username, u.role, s.last_seen FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [sid],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  if (t - Number(row.last_seen) > idleTimeoutMs) {
    await db.query("DELETE FROM sessions WHERE id = $1", [sid]);
    return undefined;
  }
  await db.query("UPDATE sessions SET last_seen = $1 WHERE id = $2", [t, sid]);
  return { id: row.id, username: row.username, role: row.role };
}

/**
 * 登入失敗計數存 Postgres（username+ip），多實例共用。
 * 以 INSERT … ON CONFLICT DO UPDATE … 原子累加，避免 read-then-write 競態。
 */
export class LoginLimiter {
  constructor(
    private db: Db,
    private maxFailures: number,
    private windowMs: number,
    private now: Clock = Date.now,
  ) {}

  async blocked(u: string, ip: string): Promise<boolean> {
    const cutoff = this.now() - this.windowMs;
    const r = await this.db.query<{ failure_count: number; window_started_at: string | number }>(
      `SELECT failure_count, window_started_at FROM login_failures
       WHERE username = $1 AND ip = $2`,
      [u, ip],
    );
    const row = r.rows[0];
    if (!row) return false;
    if (Number(row.window_started_at) <= cutoff) return false;
    return Number(row.failure_count) >= this.maxFailures;
  }

  async fail(u: string, ip: string): Promise<void> {
    const t = this.now();
    const cutoff = t - this.windowMs;
    await this.db.query(
      `INSERT INTO login_failures (username, ip, failure_count, window_started_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (username, ip) DO UPDATE SET
         failure_count = CASE
           WHEN login_failures.window_started_at <= $4 THEN 1
           ELSE login_failures.failure_count + 1
         END,
         window_started_at = CASE
           WHEN login_failures.window_started_at <= $4 THEN $3
           ELSE login_failures.window_started_at
         END`,
      [u, ip, t, cutoff],
    );
  }

  async reset(u: string, ip: string): Promise<void> {
    await this.db.query(
      "DELETE FROM login_failures WHERE username = $1 AND ip = $2",
      [u, ip],
    );
  }
}

export function deny(reply: FastifyReply, code: 401 | 403): FastifyReply {
  return reply.code(code).send({ error: code === 401 ? "未登入" : "權限不足" });
}
