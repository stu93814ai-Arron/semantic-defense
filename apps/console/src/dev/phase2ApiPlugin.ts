import type { Plugin } from "vite";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type Role = "operator" | "app_owner" | "platform_admin";
type User = { username: string; password: string; role: Role; appIds: string[] };
type Session = { username: string; role: Role; appIds: string[]; lastAccess: number };
type Failure = { count: number; windowStartedAt: number };

const USERS: User[] = [
  { username: "operator1", password: "pass-operator-1", role: "operator", appIds: [] },
  { username: "owner1", password: "pass-owner-1", role: "app_owner", appIds: ["app-alpha"] },
  { username: "owner2", password: "pass-owner-2", role: "app_owner", appIds: ["app-beta"] },
  { username: "admin1", password: "pass-admin-1", role: "platform_admin", appIds: [] },
];

const LOGIN_ERROR = "帳號或密碼錯誤";
const RATE_MSG = "帳號或密碼錯誤，請稍後再試";
const RID_COOKIE = "sd_rid";

function idleMs(): number {
  const raw = process.env.VITE_IDLE_TIMEOUT_MS ?? process.env.IDLE_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

function rateMax(): number {
  const n = Number(process.env.LOGIN_RATE_MAX ?? "5");
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function rateWindowMs(): number {
  const n = Number(process.env.LOGIN_RATE_WINDOW_MS ?? "60000");
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string | string[]>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(payload);
}

function clearSessionCookie(): string {
  return "sd_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

function sessionCookie(token: string): string {
  return `sd_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function ridCookie(rid: string): string {
  return `${RID_COOKIE}=${rid}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/** 開發／E2E 用：對齊 control-api 第 2 階段契約（非正式控制程序）。 */
export function phase2ApiPlugin(): Plugin {
  const sessions = new Map<string, Session>();
  const failures = new Map<string, Failure>();

  return {
    name: "phase2-api",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        touchOrExpire(req, sessions);
        next();
      });
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/api/")) return next();
        try {
          await handle(req, res, url, sessions, failures);
        } catch {
          json(res, 500, { error: "內部錯誤" });
        }
      });
    },
  };
}

function touchOrExpire(
  req: IncomingMessage,
  sessions: Map<string, Session>,
): void {
  const token = parseCookie(req.headers.cookie, "sd_session");
  if (!token) return;
  const session = sessions.get(token);
  if (!session) return;
  if (Date.now() - session.lastAccess > idleMs()) {
    sessions.delete(token);
    return;
  }
  session.lastAccess = Date.now();
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  sessions: Map<string, Session>,
  failures: Map<string, Failure>,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "POST" && url === "/api/session/login") {
    return handleLogin(req, res, sessions, failures);
  }
  if (method === "POST" && url === "/api/session/logout") {
    const token = parseCookie(req.headers.cookie, "sd_session");
    if (token) sessions.delete(token);
    return json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  const session = requireSession(req, res, sessions);
  if (!session) return;

  if (method === "GET" && url === "/api/session/me") {
    return json(res, 200, { username: session.username, role: session.role });
  }

  return handleAuthedGet(method, url, session, res);
}

function ensureRid(
  req: IncomingMessage,
  setCookies: string[],
): string {
  const existing = parseCookie(req.headers.cookie, RID_COOKIE);
  if (existing) return existing;
  const rid = randomBytes(12).toString("hex");
  setCookies.push(ridCookie(rid));
  return rid;
}

function rateKey(username: string, rid: string, ip: string): string {
  // 以瀏覽器 context 的 sd_rid 隔離 E2E 計數，避免跨測試污染且不需在 GET /login 重置
  return `${username}|${rid}|${ip}`;
}

function isBlocked(failures: Map<string, Failure>, key: string, now: number): boolean {
  const row = failures.get(key);
  if (!row) return false;
  if (row.windowStartedAt <= now - rateWindowMs()) return false;
  return row.count >= rateMax();
}

function recordFail(failures: Map<string, Failure>, key: string, now: number): void {
  const cutoff = now - rateWindowMs();
  const row = failures.get(key);
  if (!row || row.windowStartedAt <= cutoff) {
    failures.set(key, { count: 1, windowStartedAt: now });
    return;
  }
  failures.set(key, { count: row.count + 1, windowStartedAt: row.windowStartedAt });
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
  failures: Map<string, Failure>,
): Promise<void> {
  const raw = await readBody(req);
  let username = "";
  let password = "";
  try {
    const body = JSON.parse(raw) as { username?: string; password?: string };
    username = String(body.username ?? "");
    password = String(body.password ?? "");
  } catch {
    return json(res, 401, { error: LOGIN_ERROR });
  }

  const setCookies: string[] = [];
  const rid = ensureRid(req, setCookies);
  const ip = req.socket.remoteAddress ?? "local";
  const key = rateKey(username, rid, ip);
  const now = Date.now();

  if (isBlocked(failures, key, now)) {
    return json(res, 429, { error: RATE_MSG }, setCookies.length ? { "Set-Cookie": setCookies } : undefined);
  }

  const user = USERS.find((u) => u.username === username && u.password === password);
  if (!user) {
    recordFail(failures, key, now);
    return json(res, 401, { error: LOGIN_ERROR }, setCookies.length ? { "Set-Cookie": setCookies } : undefined);
  }

  failures.delete(key);
  const token = randomBytes(24).toString("hex");
  sessions.set(token, {
    username: user.username,
    role: user.role,
    appIds: user.appIds,
    lastAccess: now,
  });
  setCookies.push(sessionCookie(token));
  return json(res, 200, { ok: true }, { "Set-Cookie": setCookies });
}

function requireSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
): Session | null {
  const token = parseCookie(req.headers.cookie, "sd_session");
  if (!token) {
    json(res, 401, { error: "未登入" }, { "Set-Cookie": clearSessionCookie() });
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    json(res, 401, { error: "未登入" }, { "Set-Cookie": clearSessionCookie() });
    return null;
  }
  const now = Date.now();
  if (now - session.lastAccess > idleMs()) {
    sessions.delete(token);
    json(res, 401, { error: "工作階段已逾時" }, { "Set-Cookie": clearSessionCookie() });
    return null;
  }
  session.lastAccess = now;
  return session;
}

function deny403(res: ServerResponse): void {
  json(res, 403, { error: "權限不足" });
}

function emptyItems(res: ServerResponse): void {
  json(res, 200, { items: [] });
}

function requireRole(session: Session, role: Role, res: ServerResponse): boolean {
  if (session.role === role) return true;
  deny403(res);
  return false;
}

function handleOperatorGet(url: string, session: Session, res: ServerResponse): boolean {
  const lists = url === "/api/judgments" || url === "/api/judgments/history" || url === "/api/constraints";
  const caseGet = /^\/api\/judgments\/[^/]+$/.test(url);
  if (!lists && !caseGet) return false;
  if (!requireRole(session, "operator", res)) return true;
  if (lists) emptyItems(res);
  else json(res, 404, { error: "查無案件" });
  return true;
}

function handleAdminGet(url: string, session: Session, res: ServerResponse): boolean {
  const lists = url === "/api/admin/users" || url === "/api/audit" || url === "/api/versions";
  if (lists) {
    if (requireRole(session, "platform_admin", res)) emptyItems(res);
    return true;
  }
  if (url === "/api/health") {
    if (requireRole(session, "platform_admin", res)) json(res, 200, { status: "ok" });
    return true;
  }
  return false;
}

function handleOwnerGet(url: string, session: Session, res: ServerResponse): boolean {
  const appMatch = /^\/api\/apps\/([^/]+)(\/map)?$/.exec(url);
  if (!appMatch) return false;
  if (!requireRole(session, "app_owner", res)) return true;
  const appId = appMatch[1]!;
  if (!session.appIds.includes(appId)) {
    json(res, 404, { error: "查無應用" });
    return true;
  }
  if (appMatch[2]) json(res, 200, { appId, items: [] });
  else json(res, 200, { id: appId });
  return true;
}

function handleAuthedGet(
  method: string,
  url: string,
  session: Session,
  res: ServerResponse,
): void {
  if (method !== "GET") {
    json(res, 404, { error: "Not Found" });
    return;
  }
  if (handleOperatorGet(url, session, res)) return;
  if (handleAdminGet(url, session, res)) return;
  if (handleOwnerGet(url, session, res)) return;
  json(res, 404, { error: "Not Found" });
}
