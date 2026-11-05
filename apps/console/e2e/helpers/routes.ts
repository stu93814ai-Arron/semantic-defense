/**
 * 介面路徑清單。
 * - PLAN.md「角色與路由」表
 * - 監看模式加列見 PLAN-ADDENDUM-MONITOR.md §7a（提交 96f29d9；優先於 PLAN.md 表）
 *   第 3 階段：/blacklist/review、/blacklist、/whitelist
 *   第 5 階段 /mode 不納入本檔（總召裁示）
 */

/** PLAN.md ＋ 附錄第 3 階段監看路徑（含參數範例）。不含第 5 階段 /mode。 */
export const PLAN_ROUTES = [
  "/login",
  "/admin/users",
  "/apps/new",
  "/apps/app-alpha/map",
  "/judgments",
  "/judgments/case-fixture-1",
  "/judgments/history",
  "/constraints",
  // 附錄 96f29d9 §7a — 第 3 階段（operator）
  "/blacklist/review",
  "/blacklist",
  // 附錄 96f29d9 §7a — 第 3 階段（platform_admin）
  "/whitelist",
  "/audit",
  "/versions",
  "/health",
] as const;

export const OPERATOR_ROUTES = [
  "/judgments",
  "/judgments/case-fixture-1",
  "/judgments/history",
  "/constraints",
  "/blacklist/review", // 附錄 96f29d9
  "/blacklist", // 附錄 96f29d9
] as const;

export const OWNER_ROUTES = ["/apps/new", "/apps/app-alpha/map"] as const;

export const ADMIN_ROUTES = [
  "/admin/users",
  "/audit",
  "/versions",
  "/health",
  "/whitelist", // 附錄 96f29d9
] as const;
