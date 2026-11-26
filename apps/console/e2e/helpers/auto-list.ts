import type { Page, Route } from "@playwright/test";

/**
 * B1 驗收用：模擬 GET／PUT /api/settings/auto-list。
 * 路徑與本文對齊 packages/contracts `ADMIN_API_PATHS.autoList`、`AutoListSettingSchema`（只 { enabled: boolean }）。
 * PUT enabled:true 目前一律 409，本文見 docs/decisions/2026-11-17-auto-list-setting.md 與
 * apps/control-api/src/auto-list-settings.ts。不改開關值。
 * dev phase2ApiPlugin 未接此路徑；這裡用 Playwright route，不在 src 加路由。
 */
export const AUTO_LIST_PATH = "/api/settings/auto-list";
export const HANDSHAKE_BLOCKED = "三向交握佐證尚未上線，暫不能開啟自動上榜。";
/** phase2ApiPlugin 對未接的 GET 回這份 404 本文；adminApi 原樣顯示。 */
export const PLUGIN_NOT_FOUND = "Not Found";

export type AutoListPut = { enabled: boolean };

export type AutoListMock = {
  gets: number;
  puts: AutoListPut[];
  /** 非 GET／HEAD 的 /api/blacklist 寫入（契約 ADMIN_API_PATHS.blacklist 前綴）。 */
  blacklistWrites: string[];
  setEnabled: (enabled: boolean) => void;
};

type State = { enabled: boolean; failRead: boolean };

type InstallOpts = { enabled?: boolean; failRead?: boolean };

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function enabledFlag(raw: string | null): boolean | null {
  if (raw === null || raw === "") return null;
  const body = parseJson(raw);
  if (!isRecord(body) || !("enabled" in body)) return null;
  return typeof body.enabled === "boolean" ? body.enabled : null;
}

function isBlacklistWrite(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  return path === "/api/blacklist" || path.startsWith("/api/blacklist/");
}

function noteBlacklistWrites(page: Page, writes: string[]): void {
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (!isBlacklistWrite(req.method(), path)) return;
    writes.push(`${req.method()} ${path}`);
  });
}

async function fulfillGet(route: Route, state: State, mock: AutoListMock): Promise<void> {
  mock.gets += 1;
  if (state.failRead) {
    await json(route, 404, { error: PLUGIN_NOT_FOUND });
    return;
  }
  await json(route, 200, { enabled: state.enabled });
}

async function fulfillPut(route: Route, state: State, mock: AutoListMock): Promise<void> {
  const enabled = enabledFlag(route.request().postData());
  if (enabled === null) {
    await json(route, 400, { error: "請求格式錯誤" });
    return;
  }
  mock.puts.push({ enabled });
  if (enabled) {
    await json(route, 409, { error: HANDSHAKE_BLOCKED });
    return;
  }
  state.enabled = false;
  await json(route, 200, { enabled: false });
}

async function dispatch(route: Route, state: State, mock: AutoListMock): Promise<void> {
  const method = route.request().method();
  if (method === "GET") {
    await fulfillGet(route, state, mock);
    return;
  }
  if (method === "PUT") {
    await fulfillPut(route, state, mock);
    return;
  }
  await route.fallback();
}

export async function installAutoListMock(page: Page, opts: InstallOpts = {}): Promise<AutoListMock> {
  const state: State = { enabled: opts.enabled ?? false, failRead: opts.failRead ?? false };
  const mock: AutoListMock = {
    gets: 0,
    puts: [],
    blacklistWrites: [],
    setEnabled(enabled: boolean) {
      state.enabled = enabled;
    },
  };
  noteBlacklistWrites(page, mock.blacklistWrites);
  await page.route(
    (url) => url.pathname === AUTO_LIST_PATH,
    (route) => dispatch(route, state, mock),
  );
  return mock;
}
