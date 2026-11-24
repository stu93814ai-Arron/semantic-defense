import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts";
import type { Queryable } from "../src/db.js";
import { buildApp, seedPhase2Fixtures, type BuildAppOptions, type ControlApi } from "./helpers/app.js";
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

/**
 * 測試專用：把三向交握佐證視為已就緒，讓「開啟成功」路徑可測（僅 NODE_ENV=test 允許，見下方啟動拒絕測試）。
 * 未傳＝HANDSHAKE_EVIDENCE_READY（false），PUT enabled:true 回 409。
 */
const READY = { autoListHandshakeReady: true } as unknown as Partial<BuildAppOptions>;

async function start(extra: Partial<BuildAppOptions> = {}): Promise<ControlApi> {
  api = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => CLOCK, ...extra });
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
    await start(READY);
    const cookie = await session("admin1", "pass-admin-1");
    const res = await putSetting(cookie, { enabled: true });
    expect([res.statusCode, res.json()]).toEqual([200, { enabled: true }]);
    expect((await getSetting(cookie)).json()).toEqual({ enabled: true });
    expect(await updates()).toEqual([
      { action: ACTION, actor: "admin1", detail: { before: { enabled: false }, after: { enabled: true } } },
    ]);
  });

  it("值未變再 PUT：200 現值且不新增稽核；改回 false 才寫第二筆", async () => {
    await start(READY);
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
    await start(READY);
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
    await start(READY);
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

const HOST = "admin.example.test";
const OWN = `http://${HOST}`;
const putFrom = (cookie: string, extra: Record<string, string>, body: unknown) =>
  api!.inject({ method: "PUT", url: PATH, headers: { ...cookieHeader(cookie), host: HOST, ...extra }, payload: body as object });
const settingAudits = async () => (await api!.db.query<{ action: string; actor: string; detail: unknown }>(
  "SELECT action, actor, detail FROM audit_events WHERE action LIKE 'settings.auto_list.%' ORDER BY id",
)).rows;

describe("PUT 來源檢查（資安提出；A 組領航員裁示，未經使用者確認）", () => {
  it("跨來源 Origin，或 Sec-Fetch-Site 為 cross-site／same-site → 403 請求來源不符，值不變、無稽核", async () => {
    await start(READY);
    const cookie = await session("admin1", "pass-admin-1");
    const bad: Record<string, string>[] = [
      { origin: "https://evil.example" }, { origin: "null" }, { origin: `https://${HOST}` },
      { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
      { origin: OWN, "sec-fetch-site": "cross-site" },
    ];
    for (const h of bad) {
      const res = await putFrom(cookie, h, { enabled: true });
      expect([res.statusCode, res.json()], JSON.stringify(h)).toEqual([403, { error: "請求來源不符" }]);
    }
    expect((await getSetting(cookie)).json()).toEqual({ enabled: false });
    expect(await settingAudits()).toEqual([]);
  });

  it("對照：同源 Origin、Sec-Fetch-Site same-origin／none、兩者皆無（非瀏覽器管理用戶端）→ 照常寫入", async () => {
    await start(READY);
    const cookie = await session("admin1", "pass-admin-1");
    const ok: Record<string, string>[] = [{ origin: OWN }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, {}];
    let enabled = false;
    for (const h of ok) {
      enabled = !enabled;
      const res = await putFrom(cookie, h, { enabled });
      expect([res.statusCode, res.json()], JSON.stringify(h)).toEqual([200, { enabled }]);
    }
    expect(await updates()).toHaveLength(4);
  });
});

describe("三向交握佐證未就緒時不能開啟（軟體大總召裁示，未經使用者確認）", () => {
  const BLOCKED = { error: "三向交握佐證尚未上線，暫不能開啟自動上榜。" };

  // 實作後 it.fails 已改回 it()。本文為「三向交握佐證尚未上線，暫不能開啟自動上榜。」。
  it("PUT enabled:true → 409 固定本文，開關維持 false，寫一筆 update_blocked", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    const res = await putSetting(cookie, { enabled: true });
    expect([res.statusCode, res.json()]).toEqual([409, BLOCKED]);
    expect((await getSetting(cookie)).json()).toEqual({ enabled: false });
    expect(await settingAudits()).toEqual([{
      action: "settings.auto_list.update_blocked", actor: "admin1",
      detail: { requested: { enabled: true }, reason: "handshake_not_ready" },
    }]);
  });

  it("被擋之後 PUT enabled:false → 200，值為 false，不寫 update 稽核", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    await putSetting(cookie, { enabled: true });
    const off = await putSetting(cookie, { enabled: false });
    expect([off.statusCode, off.json()]).toEqual([200, { enabled: false }]);
    expect(await updates()).toEqual([]);
  });

  it("順序：格式錯誤（400）與來源不符（403）都不寫 update_blocked", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    expect((await putSetting(cookie, { enabled: true, extra: 1 })).statusCode).toBe(400);
    expect((await putFrom(cookie, { origin: "https://evil.example" }, { enabled: true })).statusCode).toBe(403);
    expect(await settingAudits()).toEqual([]);
  });

  it("關閉一律允許：未就緒時 DB 原為 true → PUT false 200，寫一筆 update", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    await api!.db.query("UPDATE auto_list_settings SET enabled = TRUE");
    const off = await putSetting(cookie, { enabled: false });
    expect([off.statusCode, off.json()]).toEqual([200, { enabled: false }]);
    expect(await updates()).toEqual([
      { action: ACTION, actor: "admin1", detail: { before: { enabled: true }, after: { enabled: false } } },
    ]);
  });
});

describe("自動上榜測試覆寫只限 NODE_ENV=test（A 組領航員裁示，未經使用者確認）", () => {
  const REFUSE = "自動上榜的測試覆寫（autoListEnabled、autoListHandshakeReady）只能在 NODE_ENV=test 使用，拒絕啟動";
  afterEach(() => { vi.unstubAllEnvs(); });

  /** 啟動成功就立刻關掉並回 "started"；失敗回錯誤訊息。 */
  const boot = (extra: Partial<BuildAppOptions>) => buildApp({ databaseUrl: requireDatabaseUrl(), ...extra })
    .then(async (a) => { await a.close(); return "started"; }, (e: unknown) => (e as Error).message);

  it("NODE_ENV 不是 test 時傳 autoListEnabled（true 或 false）→ 拒絕啟動，固定中文訊息", async () => {
    for (const env of ["production", "development"]) {
      vi.stubEnv("NODE_ENV", env);
      for (const v of [true, false]) expect(await boot({ autoListEnabled: v }), `${env}/${v}`).toBe(REFUSE);
    }
  });

  it("NODE_ENV 不是 test 時傳三向交握就緒覆寫 → 拒絕啟動，固定中文訊息", async () => {
    for (const env of ["production", "development"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(await boot(READY), env).toBe(REFUSE);
    }
  });

  it("NODE_ENV 未設定（stubEnv 移除）時傳任一覆寫 → 拒絕啟動，固定中文訊息", async () => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(process.env.NODE_ENV).toBeUndefined();
    for (const extra of [{ autoListEnabled: false }, { autoListEnabled: true }, READY]) {
      expect(await boot(extra), JSON.stringify(extra)).toBe(REFUSE);
    }
  });

  it("對照：NODE_ENV=production 不傳覆寫 → 正常啟動；NODE_ENV=test 傳覆寫 → 正常啟動", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await boot({})).toBe("started");
    vi.stubEnv("NODE_ENV", "test");
    expect(await boot({ autoListEnabled: true, ...READY })).toBe("started");
  });
});

describe("缺列 fail-closed、稽核與開關同一交易", () => {
  // A 組領航員裁示（未經使用者確認）：缺列不得視為開啟；稽核必須走 tx 內的 q，不得走 pool。
  // 現行程式已如此，故用 it()。臨時突變不提交（見該次 commit 說明）。
  it("缺列時 GET 得到 {enabled:false}，不得當成開啟", async () => {
    await start();
    const cookie = await session("admin1", "pass-admin-1");
    await api!.db.query("DELETE FROM auto_list_settings");
    const res = await getSetting(cookie);
    expect([res.statusCode, res.json()]).toEqual([200, { enabled: false }]);
  });

  it("開啟時稽核 INSERT 與 UPDATE 同一筆交易，不走 pool", async () => {
    await start(READY);
    const cookie = await session("admin1", "pass-admin-1");
    const db = api!.db;
    const poolSql: string[] = [];
    const origQuery = db.query.bind(db);
    db.query = (async <T>(sql: string, params?: unknown[]) => {
      poolSql.push(sql);
      return origQuery<T>(sql, params);
    }) as typeof db.query;
    let updateXact: string | undefined;
    let auditXact: string | undefined;
    const origTx = db.tx.bind(db);
    db.tx = (<T>(fn: (q: Queryable) => Promise<T>) => origTx(async (q) => {
      const origQ = q.query.bind(q);
      q.query = (async <R>(sql: string, params?: unknown[]) => {
        if (/UPDATE\s+auto_list_settings/i.test(sql)) {
          updateXact = (await origQ<{ id: string }>("SELECT pg_current_xact_id()::text AS id")).rows[0]!.id;
        }
        if (/INSERT\s+INTO\s+audit_events/i.test(sql)) {
          auditXact = (await origQ<{ id: string }>("SELECT pg_current_xact_id()::text AS id")).rows[0]!.id;
        }
        return origQ<R>(sql, params);
      }) as typeof q.query;
      return fn(q);
    })) as typeof db.tx;
    const res = await putSetting(cookie, { enabled: true });
    expect(res.statusCode).toBe(200);
    expect(updateXact).toEqual(expect.any(String));
    expect(auditXact).toBe(updateXact);
    expect(poolSql.some((sql) => /INSERT\s+INTO\s+audit_events/i.test(sql))).toBe(false);
  });
});
