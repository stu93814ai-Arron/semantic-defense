import { accessFor, titleFor, type SessionUser } from "../roles";

/** 頂部頁籤。項目來自既有靜態路由，不含尚未建立的儀表板。 */
export type NavTab = {
  id: string;
  label: string;
  prefixes?: readonly string[];
};

export type NavItem = {
  path: string;
  tabId: string;
  group: string;
};

export type NavLink = {
  path: string;
  label: string;
};

export type NavGroup = {
  label: string;
  items: NavLink[];
};

export const NAV_TABS: readonly NavTab[] = [
  { id: "review", label: "封鎖與審核" },
  { id: "health", label: "告警與健康" },
  { id: "judgments", label: "判斷紀錄" },
  { id: "apps", label: "應用", prefixes: ["/apps/"] },
];

/** 值勤與管理面分組；參數路由不列入，由前綴對應頁籤。 */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: "/blacklist/review", tabId: "review", group: "封鎖" },
  { path: "/blacklist", tabId: "review", group: "封鎖" },
  { path: "/whitelist", tabId: "review", group: "存取例外" },
  { path: "/judgments", tabId: "judgments", group: "判斷" },
  { path: "/judgments/history", tabId: "judgments", group: "判斷" },
  { path: "/constraints", tabId: "judgments", group: "判斷" },
  { path: "/health", tabId: "health", group: "系統" },
  { path: "/versions", tabId: "health", group: "系統" },
  { path: "/audit", tabId: "health", group: "紀錄" },
  { path: "/admin/users", tabId: "health", group: "紀錄" },
  { path: "/apps/new", tabId: "apps", group: "應用" },
];

export function matchNavItem(pathname: string): string | undefined {
  if (NAV_ITEMS.some((i) => i.path === pathname)) return pathname;
  let best: string | undefined;
  for (const item of NAV_ITEMS) {
    if (!pathname.startsWith(`${item.path}/`)) continue;
    if (item.path.length > (best?.length ?? 0)) best = item.path;
  }
  return best;
}

function tabIdByPrefix(pathname: string): string | undefined {
  for (const tab of NAV_TABS) {
    if (tab.prefixes?.some((pre) => pathname.startsWith(pre))) return tab.id;
  }
  return undefined;
}

export function tabIdForPath(pathname: string): string | undefined {
  const matched = matchNavItem(pathname);
  if (matched) return NAV_ITEMS.find((i) => i.path === matched)?.tabId;
  return tabIdByPrefix(pathname);
}

export function visibleItemsFor(user: SessionUser | null): NavItem[] {
  return NAV_ITEMS.filter((item) => accessFor(item.path, user) === "ok");
}

export function visibleTabsFor(user: SessionUser | null): NavTab[] {
  const ids = new Set(visibleItemsFor(user).map((i) => i.tabId));
  return NAV_TABS.filter((tab) => ids.has(tab.id));
}

export function activeTabId(
  pathname: string,
  user: SessionUser | null,
): string | undefined {
  const id = tabIdForPath(pathname);
  if (!id) return undefined;
  if (!visibleTabsFor(user).some((tab) => tab.id === id)) return undefined;
  return id;
}

export function tabHref(
  tabId: string,
  user: SessionUser | null,
): string | undefined {
  return visibleItemsFor(user).find((item) => item.tabId === tabId)?.path;
}

function appendToGroup(groups: NavGroup[], item: NavItem): void {
  const entry = { path: item.path, label: titleFor(item.path) };
  const last = groups.at(-1);
  if (last && last.label === item.group) {
    last.items.push(entry);
    return;
  }
  groups.push({ label: item.group, items: [entry] });
}

export function visibleGroupsFor(
  tabId: string,
  user: SessionUser | null,
): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const item of visibleItemsFor(user)) {
    if (item.tabId === tabId) appendToGroup(groups, item);
  }
  return groups;
}
