import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl, truncatePhase2Tables } from "./helpers/pg.js";

/**
 * 自動上榜總開關（/api/settings/auto-list）：僅 platform_admin 可讀寫；
 * 變更與 settings.auto_list.update 同一 tx；值未變不寫稽核。
 * 實作後 it.fails 已改回 it()。
 */

const PATH = ADMIN_API_PATHS.autoList;
const ACTION = "settings.auto_list.update";
const CLOCK = 1_800_000_000_000;

let api: ControlApi | undefined;

afterEach(async () => {
  if (api) {
    await api.close();
    api = undefined;
  }
});

async function start(): Promise<ControlApi> {
  api = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => CLOCK });
  await seedPhase2Fixtures(api);
  return api;
}

async function session(username: string, password: string): Promise<string> {
  const outcome = await login(api!, { username, password });
  expect(outcome.status).toBe(200);
  return outcome.cookie!;
}

const headers = (cookie?: string) => (cookie ? cookieHeader(cookie) : {});
const getSetting = (cookie?: string) =>
  api!.inject({ method: "GET", url: PATH, headers: headers(cookie) });
const putSetting = (cookie: string | undefined, body: unknown) =>
  api!.inject({ method: "PUT", url: PATH, headers: headers(cookie), payload: body as object });

async function updates() {
  return (await api!.db.query<{ action: string; actor: string; detail: unknown }>(
    "SELECT action, actor, detail FROM audit_events WHERE action = $1 ORDER BY id",
    [ACTION],
  )).rows;
}

describe("自動上榜總開關 API：讀寫與稽核", () => {
  it("種子列預設關閉：platform_admin GET 得到 200 {enabled:false}", async () => {
    await start();
    const res = await getSetting(await session("admin1", "pass-admin-1"));
    expect([res.statusCode, res.json()]).toEqual([200, { enabled: false }]);
  });

  it("開啟後 GET 讀回，並寫一筆物件形 before／after 稽核（actor 為正規化帳號）", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    const res = await putSetting(cookie, { enabled: true });
    expect([res.statusCode, res.json()]).toEqual([200, { enabled: true }]);
    expect((await getSetting(cookie)).json()).toEqual({ enabled: true });
    expect(await updates()).toEqual([
      { action: ACTION, actor: "admin1", detail: { before: { enabled: false }, after: { enabled: true } } },
    ]);
  });

  it("值未變再 PUT：200 現值且不新增稽核；改回 false 才寫第二筆", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    expect((await putSetting(cookie, { enabled: true })).statusCode).toBe(200);
    const same = await putSetting(cookie, { enabled: true });
    expect([same.statusCode, same.json()]).toEqual([200, { enabled: true }]);
    expect(await updates()).toHaveLength(1);
    const off = await putSetting(cookie, { enabled: false });
    expect([off.statusCode, off.json()]).toEqual([200, { enabled: false }]);
    expect(await updates()).toEqual([
      { action: ACTION, actor: "admin1", detail: { before: { enabled: false }, after: { enabled: true } } },
      { action: ACTION, actor: "admin1", detail: { before: { enabled: true }, after: { enabled: false } } },
    ]);
  });

  it("預設 false 再 PUT false：200、完全不寫稽核", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    const res = await putSetting(cookie, { enabled: false });
    expect([res.statusCode, res.json()]).toEqual([200, { enabled: false }]);
    expect(await updates()).toEqual([]);
  });

});

describe("自動上榜總開關 API：格式、角色與原子性", () => {
  it("strict 失敗（缺欄、非布林、多餘鍵）→ 400 請求格式錯誤，不改值、不寫稽核", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    const invalid = [
      undefined, {}, { enabled: "true" }, { enabled: 1 }, { enabled: null },
      { enabled: true, extra: false }, [], true,
    ];
    for (const body of invalid) {
      const res = await putSetting(cookie, body);
      expect([res.statusCode, res.json()], JSON.stringify(body)).toEqual([400, { error: "請求格式錯誤" }]);
    }
    expect((await getSetting(cookie)).json()).toEqual({ enabled: false });
    expect(await updates()).toEqual([]);
  });

  it("非 platform_admin：已登入 403 權限不足、匿名 401 未登入；值與稽核不變", async () => {
    await start();
    for (const [username, password] of [["operator1", "pass-operator-1"], ["owner1", "pass-owner-1"]] as const) {
      const cookie = await session(username, password);
      const read = await getSetting(cookie);
      const write = await putSetting(cookie, { enabled: true });
      expect([read.statusCode, read.json()], username).toEqual([403, { error: "權限不足" }]);
      expect([write.statusCode, write.json()], username).toEqual([403, { error: "權限不足" }]);
    }
    const anonRead = await getSetting();
    const anonWrite = await putSetting(undefined, { enabled: true });
    expect([anonRead.statusCode, anonRead.json()]).toEqual([401, { error: "未登入" }]);
    expect([anonWrite.statusCode, anonWrite.json()]).toEqual([401, { error: "未登入" }]);
    expect((await getSetting(await session("admin1", "pass-admin-1"))).json()).toEqual({ enabled: false });
    expect(await updates()).toEqual([]);
  });

  it("稽核寫入失敗時整筆 tx 回滾：500 固定本文，開關維持關閉", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    await api!.db.exec(
      "ALTER TABLE audit_events ADD CONSTRAINT al_no_upd CHECK (action <> 'settings.auto_list.update') NOT VALID",
    );
    let res;
    try {
      res = await putSetting(cookie, { enabled: true });
    } finally {
      await api!.db.exec("ALTER TABLE audit_events DROP CONSTRAINT al_no_upd");
    }
    expect([res!.statusCode, res!.json()]).toEqual([500, { error: "伺服器錯誤" }]);
    expect((await getSetting(cookie)).json()).toEqual({ enabled: false });
    expect(await updates()).toEqual([]);
  });

  it("單列約束：migrate 種下唯一一列 {id:true,enabled:false}；id 必須為 TRUE，不能插入第二列", async () => {
    await start();
    expect((await api!.db.query("SELECT id, enabled FROM auto_list_settings")).rows).toEqual([{ id: true, enabled: false }]);
    await expect(api!.db.query("INSERT INTO auto_list_settings (id, enabled) VALUES (FALSE, TRUE)")).rejects.toThrow();
    await expect(api!.db.query("INSERT INTO auto_list_settings (id, enabled) VALUES (TRUE, TRUE)")).rejects.toThrow();
  });
});

describe("自動上榜總開關 API：與熔斷、測試清理的關係", () => {
  it("PUT 開關不重設、不清空熔斷：auto_breaker.opened_at 原樣保留", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    await api!.db.query("UPDATE auto_breaker SET opened_at = $1 WHERE id", [CLOCK - 60_000]);
    const breaker = async () => (await api!.db.query<{ opened_at: string | null }>("SELECT opened_at FROM auto_breaker")).rows;
    for (const enabled of [true, false, true]) expect((await putSetting(cookie, { enabled })).json()).toEqual({ enabled });
    expect(await breaker()).toEqual([{ opened_at: String(CLOCK - 60_000) }]);
    await api!.db.query("UPDATE auto_breaker SET opened_at = NULL WHERE id");
  });

  it("seedPhase2Fixtures 與 truncatePhase2Tables 都把開關重設為 false（缺列時補回種子列）", async () => {
    await start();
    await api!.db.query("UPDATE auto_list_settings SET enabled = TRUE");
    await seedPhase2Fixtures(api!);
    const rows = async () => (await api!.db.query("SELECT id, enabled FROM auto_list_settings")).rows;
    expect(await rows()).toEqual([{ id: true, enabled: false }]);
    await api!.db.query("UPDATE auto_list_settings SET enabled = TRUE");
    await truncatePhase2Tables(api!.db);
    expect(await rows()).toEqual([{ id: true, enabled: false }]);
    await api!.db.query("DELETE FROM auto_list_settings");
    await truncatePhase2Tables(api!.db);
    expect(await rows()).toEqual([{ id: true, enabled: false }]);
  });
});
