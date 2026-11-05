import type { Plugin } from "vite";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type Role = "operator" | "app_owner" | "platform_admin";
type User = { username: string; password: string; role: Role; appIds: string[] };
type Session = { username: string; role: Role; appIds: string[]; lastAccess: number };

const USERS: User[] = [
  { username: "operator1", password: "pass-operator-1", role: "operator", appIds: [] },
  { username: "owner1", password: "pass-owner-1", role: "app_owner", appIds: ["app-alpha"] },
  { username: "owner2", password: "pass-owner-2", role: "app_owner", appIds: ["app-beta"] },
  { username: "admin1", password: "pass-admin-1", role: "platform_admin", appIds: [] },
];

const LOGIN_ERROR = "帳號或密碼錯誤";
const RATE_MSG = "帳號或密碼錯誤，請稍後再試";

function idleMs(): number {
  const raw = process.env.VITE_IDLE_TIMEOUT_MS ?? process.env.IDLE_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

function rateMax(): number {
  const n = Number(process.env.LOGIN_RATE_MAX ?? "5");
  return Number.isFinite(n) && n > 0 ? n : 5;
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

function clearCookieHeaders(): string[] {
  return [
    "sd_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    "sd_hint=; Path=/; Secure; SameSite=Strict; Max-Age=0",
  ];
}

function encodeHint(user: User): string {
  return encodeURIComponent(
    JSON.stringify({
      username: user.username,
      role: user.role,
      appIds: user.appIds,
    }),
  );
}

function sessionCookieHeaders(token: string, user: User): string[] {
  return [
    `sd_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    `sd_hint=${encodeHint(user)}; Path=/; Secure; SameSite=Strict`,
  ];
}

/** 開發／E2E 用：對齊 control-api 第 2 階段測試面契約（非正式控制程序）。 */
export function phase2ApiPlugin(): Plugin {
  const sessions = new Map<string, Session>();
  const failures = new Map<string, number>();

  return {
    name: "phase2-api",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if ((req.method ?? "GET").toUpperCase() === "GET" && url === "/login") {
          failures.clear();
        }
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
  failures: Map<string, number>,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "POST" && url === "/api/session/login") {
    return handleLogin(req, res, sessions, failures);
  }
  if (method === "POST" && url === "/api/session/logout") {
    const token = parseCookie(req.headers.cookie, "sd_session");
    if (token) sessions.delete(token);
    return json(res, 200, { ok: true }, { "Set-Cookie": clearCookieHeaders() });
  }

  const session = requireSession(req, res, sessions);
  if (!session) return;

  if (method === "GET" && url === "/api/session/me") {
    return json(res, 200, {
      username: session.username,
      role: session.role,
      appIds: session.appIds,
    });
  }

  return handleAuthedGet(method, url, session, res);
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
  failures: Map<string, number>,
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

  const ip = req.socket.remoteAddress ?? "local";
  const key = `${username}|${ip}`;
  const count = failures.get(key) ?? 0;
  if (count >= rateMax()) {
    return json(res, 429, { error: RATE_MSG });
  }

  const user = USERS.find((u) => u.username === username && u.password === password);
  if (!user) {
    failures.set(key, count + 1);
    return json(res, 401, { error: LOGIN_ERROR });
  }

  failures.delete(key);
  const token = randomBytes(24).toString("hex");
  sessions.set(token, {
    username: user.username,
    role: user.role,
    appIds: user.appIds,
    lastAccess: Date.now(),
  });
  return json(
    res,
    200,
    { username: user.username, role: user.role, appIds: user.appIds },
    { "Set-Cookie": sessionCookieHeaders(token, user) },
  );
}

function requireSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
): Session | null {
  const token = parseCookie(req.headers.cookie, "sd_session");
  if (!token) {
    json(res, 401, { error: "未登入" }, { "Set-Cookie": clearCookieHeaders() });
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    json(res, 401, { error: "未登入" }, { "Set-Cookie": clearCookieHeaders() });
    return null;
  }
  const now = Date.now();
  if (now - session.lastAccess > idleMs()) {
    sessions.delete(token);
    json(res, 401, { error: "工作階段已逾時" }, { "Set-Cookie": clearCookieHeaders() });
    return null;
  }
  session.lastAccess = now;
  return session;
}

function allowOperator(session: Session, res: ServerResponse): void {
  if (session.role === "operator") json(res, 200, []);
  else json(res, 403, { error: "無權限" });
}

function allowAdmin(session: Session, res: ServerResponse): void {
  if (session.role === "platform_admin") json(res, 200, []);
  else json(res, 403, { error: "無權限" });
}

function allowOwnerApp(url: string, session: Session, res: ServerResponse): boolean {
  const app = /^\/api\/apps\/([^/]+)(?:\/map)?$/.exec(url);
  if (!app) return false;
  const appId = app[1]!;
  if (session.role !== "app_owner" || !session.appIds.includes(appId)) {
    json(res, 403, { error: "無權限" });
  } else {
    json(res, 200, {});
  }
  return true;
}

function handleAuthedGet(
  method: string,
  url: string,
  session: Session,
  res: ServerResponse,
): void {
  if (method !== "GET") {
    json(res, 404, { error: "不存在" });
    return;
  }
  if (url.startsWith("/api/judgments") || url === "/api/constraints") {
    allowOperator(session, res);
    return;
  }
  if (
    url === "/api/admin/users" ||
    url === "/api/audit" ||
    url === "/api/versions" ||
    url === "/api/health"
  ) {
    allowAdmin(session, res);
    return;
  }
  if (allowOwnerApp(url, session, res)) return;
  json(res, 404, { error: "不存在" });
}
