export type Role = "operator" | "app_owner" | "platform_admin";

export type SessionUser = {
  username: string;
  role: Role;
  appIds: string[];
};

function isOperatorPath(path: string): boolean {
  return path.startsWith("/judgments") || path === "/constraints" || path.startsWith("/constraints/");
}

function ownerAccess(path: string, user: SessionUser): "ok" | "deny" {
  if (path === "/apps/new") return "ok";
  const map = /^\/apps\/([^/]+)\/map$/.exec(path);
  if (!map) return "deny";
  return user.appIds.includes(map[1]!) ? "ok" : "deny";
}

function isAdminPath(path: string): boolean {
  return (
    path === "/admin/users" ||
    path === "/audit" ||
    path === "/versions" ||
    path === "/health"
  );
}

/** 回傳 null 表示此路徑需登入且角色不符時顯示無權限；login 公開。 */
export function accessFor(path: string, user: SessionUser | null): "ok" | "login" | "deny" {
  if (path === "/login" || path.startsWith("/login?")) return "ok";
  if (!user) return "login";
  if (isOperatorPath(path)) return user.role === "operator" ? "ok" : "deny";
  if (path.startsWith("/apps/")) {
    return user.role === "app_owner" ? ownerAccess(path, user) : "deny";
  }
  if (isAdminPath(path)) return user.role === "platform_admin" ? "ok" : "deny";
  return "deny";
}

function staticTitle(path: string): string | undefined {
  if (path === "/admin/users") return "人員與角色";
  if (path === "/apps/new") return "應用接入";
  if (path === "/judgments") return "待判斷";
  if (path === "/judgments/history") return "判斷紀錄";
  if (path === "/constraints") return "生效限制";
  if (path === "/audit") return "稽核";
  if (path === "/versions") return "版本與影子流量";
  if (path === "/health") return "平台健康";
  return undefined;
}

export function titleFor(path: string): string {
  const fixed = staticTitle(path);
  if (fixed) return fixed;
  if (/^\/apps\/[^/]+\/map$/.test(path)) return "應用地圖";
  if (/^\/judgments\/[^/]+$/.test(path)) return "單一判斷";
  return "頁面";
}
