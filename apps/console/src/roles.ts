export type Role = "operator" | "app_owner" | "platform_admin";

export type SessionUser = {
  username: string;
  role: Role;
};

function isOperatorPath(path: string): boolean {
  return (
    path.startsWith("/judgments") ||
    path === "/constraints" ||
    path.startsWith("/constraints/") ||
    path === "/blacklist" ||
    path.startsWith("/blacklist/")
  );
}

function isAdminPath(path: string): boolean {
  return (
    path === "/admin/users" ||
    path === "/audit" ||
    path === "/versions" ||
    path === "/health" ||
    path === "/whitelist" ||
    path === "/mode"
  );
}

function isOwnerPath(path: string): boolean {
  return path === "/apps/new" || /^\/apps\/[^/]+\/map$/.test(path);
}

/**
 * 角色層閘門。應用地圖的「是否己應用」改由 API 404/403 決定，不在此用 appIds。
 */
export function accessFor(path: string, user: SessionUser | null): "ok" | "login" | "deny" {
  if (path === "/login" || path.startsWith("/login?")) return "ok";
  if (!user) return "login";
  if (isOperatorPath(path)) return user.role === "operator" ? "ok" : "deny";
  if (isOwnerPath(path)) return user.role === "app_owner" ? "ok" : "deny";
  if (isAdminPath(path)) return user.role === "platform_admin" ? "ok" : "deny";
  return "deny";
}

const TITLES: Record<string, string> = {
  "/admin/users": "人員與角色",
  "/apps/new": "應用接入",
  "/judgments": "待判斷",
  "/judgments/history": "判斷紀錄",
  "/constraints": "生效限制",
  "/audit": "稽核",
  "/versions": "版本與影子流量",
  "/health": "平台健康",
  "/blacklist/review": "黑名單審核",
  "/blacklist": "黑名單撤回",
  "/whitelist": "白名單",
  "/mode": "模式切換",
};

function staticTitle(path: string): string | undefined {
  for (const [key, title] of Object.entries(TITLES)) {
    if (key === path) return title;
  }
  return undefined;
}

export function titleFor(path: string): string {
  const fixed = staticTitle(path);
  if (fixed) return fixed;
  if (/^\/apps\/[^/]+\/map$/.test(path)) return "應用地圖";
  if (/^\/judgments\/[^/]+$/.test(path)) return "單一判斷";
  return "頁面";
}

export function isAppMapPath(path: string): boolean {
  return /^\/apps\/[^/]+\/map$/.test(path);
}

export function parseMeBody(body: unknown): SessionUser | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { username?: unknown; role?: unknown };
  if (typeof b.username !== "string" || typeof b.role !== "string") return null;
  if (
    b.role !== "operator" &&
    b.role !== "app_owner" &&
    b.role !== "platform_admin"
  ) {
    return null;
  }
  return { username: b.username, role: b.role };
}
