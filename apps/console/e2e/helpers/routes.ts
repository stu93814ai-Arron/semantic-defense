/** PLAN.md 全部介面路徑（含參數範例）。 */
export const PLAN_ROUTES = [
  "/login",
  "/admin/users",
  "/apps/new",
  "/apps/app-alpha/map",
  "/judgments",
  "/judgments/case-fixture-1",
  "/judgments/history",
  "/constraints",
  "/audit",
  "/versions",
  "/health",
] as const;

export const OPERATOR_ROUTES = [
  "/judgments",
  "/judgments/case-fixture-1",
  "/judgments/history",
  "/constraints",
] as const;

export const OWNER_ROUTES = ["/apps/new", "/apps/app-alpha/map"] as const;

export const ADMIN_ROUTES = [
  "/admin/users",
  "/audit",
  "/versions",
  "/health",
] as const;
