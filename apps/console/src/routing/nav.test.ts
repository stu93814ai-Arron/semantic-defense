import { describe, expect, it } from "vitest";
import { accessFor, titleFor, type SessionUser } from "../roles";
import {
  NAV_ITEMS,
  NAV_TABS,
  activeTabId,
  matchNavItem,
  tabHref,
  visibleGroupsFor,
  visibleItemsFor,
  visibleTabsFor,
} from "./nav";

const op: SessionUser = { username: "operator1", role: "operator" };
const owner: SessionUser = { username: "owner1", role: "app_owner" };
const admin: SessionUser = { username: "admin1", role: "platform_admin" };

const KNOWN_PATHS = new Set([
  "/admin/users",
  "/apps/new",
  "/judgments",
  "/judgments/history",
  "/constraints",
  "/blacklist/review",
  "/blacklist",
  "/whitelist",
  "/audit",
  "/versions",
  "/health",
]);

describe("NAV_ITEMS", () => {
  it("只含既有靜態路由，標籤沿用 titleFor", () => {
    const paths = NAV_ITEMS.map((i) => i.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const item of NAV_ITEMS) {
      expect(KNOWN_PATHS.has(item.path)).toBe(true);
      expect(titleFor(item.path)).not.toBe("頁面");
    }
    for (const tab of NAV_TABS) {
      expect(NAV_ITEMS.some((i) => i.tabId === tab.id)).toBe(true);
    }
  });
});

describe("matchNavItem／activeTabId", () => {
  it("精確路徑命中對應項目與頁籤", () => {
    expect(matchNavItem("/blacklist/review")).toBe("/blacklist/review");
    expect(activeTabId("/blacklist/review", op)).toBe("review");
    expect(matchNavItem("/judgments/history")).toBe("/judgments/history");
    expect(activeTabId("/judgments/history", op)).toBe("judgments");
    expect(matchNavItem("/health")).toBe("/health");
    expect(activeTabId("/health", admin)).toBe("health");
  });

  it("參數路徑命中最長前綴；/apps/:id/map 只亮應用頁籤", () => {
    expect(matchNavItem("/judgments/case-fixture-1")).toBe("/judgments");
    expect(activeTabId("/judgments/case-fixture-1", op)).toBe("judgments");
    expect(matchNavItem("/apps/app-alpha/map")).toBeUndefined();
    expect(activeTabId("/apps/app-alpha/map", owner)).toBe("apps");
  });

  it("越權或未知路徑不亮頁籤", () => {
    expect(activeTabId("/health", op)).toBeUndefined();
    expect(activeTabId("/judgments", admin)).toBeUndefined();
    expect(activeTabId("/login", op)).toBeUndefined();
    expect(matchNavItem("/no-such")).toBeUndefined();
  });
});

describe("依角色過濾可見項目（前端顯示，非授權）", () => {
  it("operator 只見值勤路由，不見管理面或應用", () => {
    const paths = visibleItemsFor(op).map((i) => i.path);
    expect(paths).toEqual([
      "/blacklist/review",
      "/blacklist",
      "/judgments",
      "/judgments/history",
      "/constraints",
    ]);
    expect(visibleTabsFor(op).map((t) => t.id)).toEqual(["review", "judgments"]);
    expect(tabHref("review", op)).toBe("/blacklist/review");
    expect(tabHref("judgments", op)).toBe("/judgments");
  });

  it("platform_admin 只見管理面，app_owner 只見應用", () => {
    const adminPaths = visibleItemsFor(admin).map((i) => i.path);
    expect(adminPaths).toEqual([
      "/whitelist",
      "/health",
      "/versions",
      "/audit",
      "/admin/users",
    ]);
    expect(visibleTabsFor(admin).map((t) => t.id)).toEqual(["review", "health"]);
    expect(visibleItemsFor(owner).map((i) => i.path)).toEqual(["/apps/new"]);
    expect(visibleTabsFor(owner).map((t) => t.id)).toEqual(["apps"]);
    expect(tabHref("apps", owner)).toBe("/apps/new");
  });

  it("未登入不列出任何項目；側欄只含當前頁籤可見組", () => {
    expect(visibleItemsFor(null)).toEqual([]);
    expect(visibleTabsFor(null)).toEqual([]);
    const groups = visibleGroupsFor("review", op);
    expect(groups.map((g) => g.label)).toEqual(["封鎖"]);
    expect(groups[0]?.items.map((i) => i.path)).toEqual([
      "/blacklist/review",
      "/blacklist",
    ]);
    expect(groups[0]?.items[0]?.label).toBe(titleFor("/blacklist/review"));
    const adminReview = visibleGroupsFor("review", admin);
    expect(adminReview.map((g) => g.label)).toEqual(["存取例外"]);
    expect(adminReview[0]?.items.map((i) => i.path)).toEqual(["/whitelist"]);
  });

  it("可見項目皆通過 accessFor，越權路徑不會出現", () => {
    for (const user of [op, owner, admin]) {
      for (const item of visibleItemsFor(user)) {
        expect(accessFor(item.path, user)).toBe("ok");
      }
    }
  });
});
