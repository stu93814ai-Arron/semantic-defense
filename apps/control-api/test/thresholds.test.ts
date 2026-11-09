import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS, judgeFlows } from "@semantic-defense/contracts";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { loadThresholds } from "../src/thresholds.js";

/** ② 門檻讀寫：僅 platform_admin；每次變更與稽核同一 tx；讀回值＝判定用值。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const URL = ADMIN_API_PATHS.thresholds;
async function boot(): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => 1_800_000_000_000 });
  await seedPhase2Fixtures(app);
  return app;
}
async function as(username: string, password: string): Promise<string> {
  const r = await login(app, { username, password });
  expect(r.status).toBe(200);
  return r.cookie!;
}
const admin = () => as("admin1", "pass-admin-1");
const get = (c?: string) => app.inject({ method: "GET", url: URL, headers: c ? cookieHeader(c) : {} });
const put = (c: string | undefined, payload: unknown) =>
  app.inject({ method: "PUT", url: URL, headers: c ? cookieHeader(c) : {}, payload: payload as object });
const audits = async () =>
  (await app.db.query<{ action: string; actor: string; detail: unknown }>(
    "SELECT action, actor, detail FROM audit_events WHERE action LIKE 'thresholds.%' ORDER BY id")).rows;

describe("門檻讀寫", () => {
  it("未設定時 GET 回預設 {case:0.5, auto:0.9}", async () => {
    await boot();
    const r = await get(await admin());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ case: 0.5, auto: 0.9 });
  });

  it("platform_admin PUT 200 → GET 讀回；寫一筆 thresholds.update（detail 含新舊值）", async () => {
    await boot();
    const c = await admin();
    const r = await put(c, { case: 0.6, auto: 0.95 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ case: 0.6, auto: 0.95 });
    expect((await get(c)).json()).toEqual({ case: 0.6, auto: 0.95 });
    expect(await put(c, { case: 0.4, auto: 0.95 })).toHaveProperty("statusCode", 200);
    expect(await audits()).toEqual([
      { action: "thresholds.update", actor: "admin1", detail: { before: { case: 0.5, auto: 0.9 }, after: { case: 0.6, auto: 0.95 } } },
      { action: "thresholds.update", actor: "admin1", detail: { before: { case: 0.6, auto: 0.95 }, after: { case: 0.4, auto: 0.95 } } },
    ]);
  });

  it("zod 結構錯誤 → 400，不改值、不寫稽核", async () => {
    await boot();
    const c = await admin();
    for (const bad of [
      undefined, {}, { case: 0.5 }, { case: "0.5", auto: 0.9 }, { case: 0.5, auto: 0.9, extra: 1 }, [0.5, 0.9],
      { case: null, auto: 0.9 }, { case: 0.5, auto: true },
    ]) {
      expect((await put(c, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await get(c)).json()).toEqual({ case: 0.5, auto: 0.9 });
    expect(await audits()).toEqual([]);
  });

});

describe("門檻上下限（case 0.30–1、auto 0.70–1、case<auto）", () => {
  it.each([
    [{ case: 0.3, auto: 0.7 }], [{ case: 0.3, auto: 1 }], [{ case: 0.69, auto: 0.7 }], [{ case: 0.99, auto: 1 }],
  ])("邊界值通過：%j → 200", async (x) => {
    await boot();
    const c = await admin();
    expect((await put(c, x)).statusCode).toBe(200);
    expect((await get(c)).json()).toEqual(x);
  });

  it("數值合法但超出上下限／case≥auto → 400；每次寫一筆 thresholds.update_rejected（操作者、改前值、嘗試值），值不變", async () => {
    await boot();
    const c = await admin();
    expect((await put(c, { case: 0.6, auto: 0.95 })).statusCode).toBe(200);
    const bads = [
      { case: 0.29, auto: 0.9 }, { case: 0.5, auto: 0.69 }, { case: 0.8, auto: 0.8 }, { case: 0.95, auto: 0.9 },
      { case: -0.1, auto: 0.9 }, { case: 0.5, auto: 1.5 },
    ];
    for (const bad of bads) {
      const r = await put(c, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json()).toEqual({ error: "請求格式錯誤" });
    }
    expect((await get(c)).json()).toEqual({ case: 0.6, auto: 0.95 });
    const before = { case: 0.6, auto: 0.95 };
    expect((await audits()).slice(1)).toEqual(bads.map((attempted) => ({
      action: "thresholds.update_rejected", actor: "admin1", detail: { before, attempted },
    })));
  });

  it("從未設定時被拒：before 為預設值，表內仍無列", async () => {
    await boot();
    const c = await admin();
    expect((await put(c, { case: 0.29, auto: 0.9 })).statusCode).toBe(400);
    expect(await audits()).toEqual([{ action: "thresholds.update_rejected", actor: "admin1",
      detail: { before: { case: 0.5, auto: 0.9 }, attempted: { case: 0.29, auto: 0.9 } } }]);
    expect((await app.db.query("SELECT 1 FROM thresholds")).rows).toEqual([]);
  });

});

describe("門檻：角色", () => {
  it("operator、app_owner 讀寫皆 403；匿名 401；值不變、不寫稽核", async () => {
    await boot();
    for (const [u, p] of [["operator1", "pass-operator-1"], ["owner1", "pass-owner-1"]] as const) {
      const c = await as(u, p);
      expect((await get(c)).statusCode, u).toBe(403);
      expect((await put(c, { case: 0.6, auto: 0.95 })).statusCode, u).toBe(403);
    }
    expect((await get()).statusCode).toBe(401);
    expect((await put(undefined, { case: 0.6, auto: 0.95 })).statusCode).toBe(401);
    expect((await get(await admin())).json()).toEqual({ case: 0.5, auto: 0.9 });
    expect(await audits()).toEqual([]);
  });

});

describe("門檻：原子性、DB 約束與判定一致", () => {
  it("稽核寫入失敗 → 500，門檻不變（同一 tx）", async () => {
    await boot();
    const c = await admin();
    await app.db.exec("ALTER TABLE audit_events ADD CONSTRAINT t_no_thr CHECK (action <> 'thresholds.update') NOT VALID");
    try {
      expect((await put(c, { case: 0.6, auto: 0.95 })).statusCode).toBe(500);
    } finally {
      await app.db.exec("ALTER TABLE audit_events DROP CONSTRAINT t_no_thr");
    }
    expect((await get(c)).json()).toEqual({ case: 0.5, auto: 0.9 });
  });

  it.each([[0.95, 0.9], [0.8, 0.8], [0.29, 0.9], [0.5, 0.69], [0.5, 1.01]])(
    "DB 層 CHECK 0.30<=case<auto、0.70<=auto<=1：繞過 API 直接寫入 (%s, %s) 也被拒", async (cv, av) => {
      await boot();
      await expect(app.db.query(
        "INSERT INTO thresholds (id, case_threshold, auto_threshold) VALUES (TRUE, $1, $2)", [cv, av])).rejects.toThrow();
    });

  it("DB 層 CHECK 邊界：(0.30, 0.70) 直接寫入可過", async () => {
    await boot();
    await app.db.query("INSERT INTO thresholds (id, case_threshold, auto_threshold) VALUES (TRUE, 0.3, 0.7)");
    expect(await loadThresholds(app.db)).toEqual({ case: 0.3, auto: 0.7 });
  });

  it("讀回值＝判定用值：loadThresholds 與 GET 一致，餵給 judgeFlows 後 open_case 隨之改變", async () => {
    await boot();
    const c = await admin();
    expect(await loadThresholds(app.db)).toEqual({ case: 0.5, auto: 0.9 });
    await put(c, { case: 0.6, auto: 0.95 });
    const t = await loadThresholds(app.db);
    expect(t).toEqual((await get(c)).json());
    const flows = Array.from({ length: 30 }, (_, i) => ({
      flow_id: `550e8400-e29b-41d4-a716-${String(i + 1).padStart(12, "0")}`, app_id: "app-alpha",
      ts: new Date(Date.parse("2026-11-05T12:00:00Z") + i * 1000).toISOString(), src_ip: "192.0.2.10",
      dst_ip: "198.51.100.20", src_port: 51234, dst_port: 1000 + i, protocol: "tcp" as const,
      bytes_in: 800, bytes_out: 4000, packets: 20, duration_ms: 5000,
    }));
    const [v] = judgeFlows(flows);
    expect(v!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(v!.confidence).toBeLessThan(0.6);
    expect(v!.open_case).toBe(true);
    expect(judgeFlows(flows, t)[0]!.open_case).toBe(false);
  });
});
