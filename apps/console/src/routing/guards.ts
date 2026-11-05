import { isAppMapPath } from "../roles";

export function probeExact(path: string): string | null {
  if (path === "/judgments" || path === "/judgments/history") return "/api/judgments";
  if (path === "/constraints") return "/api/constraints";
  if (path === "/admin/users") return "/api/admin/users";
  if (path === "/audit") return "/api/audit";
  if (path === "/versions") return "/api/versions";
  if (path === "/health") return "/api/health";
  return null;
}

export function probeUrl(path: string): string | null {
  if (path === "/apps/new") return null;
  const exact = probeExact(path);
  if (exact) return exact;
  if (/^\/judgments\/[^/]+$/.test(path)) {
    return `/api/judgments/${path.slice("/judgments/".length)}`;
  }
  const m = /^\/apps\/([^/]+)\/map$/.exec(path);
  return m ? `/api/apps/${m[1]}/map` : null;
}

/**
 * API 狀態 → 頁面閘門。401 交由 unauthorized handler；
 * 應用地圖 404（查無應用）與 403 → 無權限。
 */
export function decideApiGate(
  status: number,
  path: string,
): "ok" | "deny" | "ignore" {
  if (status === 401) return "ignore";
  if (status === 403) return "deny";
  if (status === 404 && isAppMapPath(path)) return "deny";
  return "ok";
}

export type RoleGate = "ok" | "login" | "deny" | "loading";
export type ApiGate = "pending" | "ok" | "deny";

/** ProtectedEmpty 最終畫面決策（純函式，供測試）。 */
export function resolveProtectedView(
  roleGate: RoleGate,
  apiGate: ApiGate,
): "loading" | "login" | "deny" | "empty" {
  if (roleGate === "loading" || (roleGate === "ok" && apiGate === "pending")) {
    return "loading";
  }
  if (roleGate === "login") return "login";
  if (roleGate === "deny" || apiGate === "deny") return "deny";
  return "empty";
}
