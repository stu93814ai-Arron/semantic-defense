import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { CASE_TTL_MS, accumulateCase, upsertCaseHit } from "../src/cases.js";

/** 成案流程 commit 6：blacklist_cases（待審累加）與 case_hits（命中明細）存放。計畫 §4／§5；不碰 flow_events。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const T0 = Date.parse("2026-11-09T00:00:00Z");
const MIN = 60_000;
async function boot(): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => T0 });
  await seedPhase2Fixtures(app);
  return app;
}
type CaseRow = {
  case_id: string; ip: string; state: string; max_confidence: number; hit_count: number; has_late: boolean;
  created_at: string; expires_at: string; last_hit_at: string; resolved_by: string | null; resolved_at: string | null;
};
const cases = async () => (await app.db.query<CaseRow>("SELECT * FROM blacklist_cases ORDER BY created_at, case_id")).rows;
const acc = (ip: string, confidence: number, at: number, late = false) =>
  app.db.tx((q) => accumulateCase(q, { ip, confidence, late }, at));

describe("待審累加（blacklist_cases）", () => {
  it("同 IP 兩次命中 → 一筆 open；hit_count=2、max 取大、last_hit_at 更新、created_at 不變", async () => {
    await boot();
    const a = await acc("203.0.113.7", 0.6, T0);
    const b = await acc("203.0.113.7", 0.55, T0 + 5 * MIN);
    expect(b.case_id).toBe(a.case_id);
    const [c, ...rest] = await cases();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ ip: "203.0.113.7/32", state: "open", max_confidence: 0.6, hit_count: 2, has_late: false,
      created_at: String(T0), expires_at: String(T0 + CASE_TTL_MS), last_hit_at: String(T0 + 5 * MIN), resolved_at: null });
    await acc("203.0.113.7", 0.8, T0 + 6 * MIN, true);
    expect((await cases())[0]).toMatchObject({ max_confidence: 0.8, hit_count: 3, has_late: true });
  });

  it("created+23h59m 再命中 → 仍同一筆、expires_at 不延長", async () => {
    await boot();
    await acc("203.0.113.8", 0.6, T0);
    await acc("203.0.113.8", 0.6, T0 + CASE_TTL_MS - MIN);
    const all = await cases();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ hit_count: 2, expires_at: String(T0 + CASE_TTL_MS) });
  });

  it("created+24h 再命中 → 舊筆 expired（resolved_at=expires_at），開新筆", async () => {
    await boot();
    const old = await acc("203.0.113.9", 0.7, T0);
    const neu = await acc("203.0.113.9", 0.6, T0 + CASE_TTL_MS);
    expect(neu.case_id).not.toBe(old.case_id);
    expect((await cases()).map((c) => [c.case_id, c.state, c.resolved_at, c.hit_count])).toEqual([
      [old.case_id, "expired", String(T0 + CASE_TTL_MS), 1],
      [neu.case_id, "open", null, 1],
    ]);
  });

  it("兩個 tx 同時對同 IP 開案 → 只有 1 筆 open、hit_count=2", async () => {
    await boot();
    await Promise.all([acc("198.51.100.4", 0.6, T0), acc("198.51.100.4", 0.7, T0)]);
    const all = await cases();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ state: "open", hit_count: 2, max_confidence: 0.7 });
  });

  it("IPv6：2001:db8::1 存成 2001:db8::1/128；非主機前綴 → 拋錯不寫入", async () => {
    await boot();
    await acc("2001:db8::1", 0.6, T0);
    expect((await cases()).map((c) => c.ip)).toEqual(["2001:db8::1/128"]);
    await expect(acc("203.0.113.0/24", 0.6, T0)).rejects.toThrow();
    expect(await cases()).toHaveLength(1);
  });

  it("DB 層：同 IP 第二筆 open 直接 INSERT → 唯一約束拒絕；expires_at 必須＝created_at+24h", async () => {
    await boot();
    await acc("203.0.113.10", 0.6, T0);
    const raw = (expires: number) => app.db.query(
      `INSERT INTO blacklist_cases (case_id, ip, state, max_confidence, hit_count, created_at, expires_at, last_hit_at)
       VALUES (gen_random_uuid(), '203.0.113.10/32', 'open', 0.6, 1, $1, $2, $1)`, [T0, expires]);
    await expect(raw(T0 + CASE_TTL_MS)).rejects.toMatchObject({ code: "23505" });
    await expect(raw(T0 + CASE_TTL_MS + 1)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("命中明細（case_hits）", () => {
  const hit = (over: Partial<Parameters<typeof upsertCaseHit>[1]> = {}) => ({
    src_ip: "203.0.113.7", sensor_id: "s-1", app_id: "app-alpha", window_start: T0, confidence: 0.6, ontime_confidence: 0.6, ...over,
  });
  type HitRow = { src_ip: string; confidence: number; ontime_confidence: number | null; first_seen_at: string; updated_at: string };
  const hits = async () => (await app.db.query<HitRow>(
    "SELECT src_ip, confidence, ontime_confidence, first_seen_at, updated_at FROM case_hits ORDER BY src_ip")).rows;

  it("以 (ip, sensor, app, 窗) upsert：第一次 created=true；重掃 created=false、值為絕對值、first_seen_at 不變", async () => {
    await boot();
    expect(await app.db.tx((q) => upsertCaseHit(q, hit(), T0))).toEqual({ created: true });
    expect(await app.db.tx((q) => upsertCaseHit(q, hit({ confidence: 0.7, ontime_confidence: null }), T0 + MIN)))
      .toEqual({ created: false });
    expect(await hits()).toEqual([{ src_ip: "203.0.113.7/32", confidence: 0.7, ontime_confidence: null,
      first_seen_at: String(T0), updated_at: String(T0 + MIN) }]);
  });

  it("不同 sensor／app／窗各算一筆", async () => {
    await boot();
    for (const h of [hit(), hit({ sensor_id: "s-2" }), hit({ app_id: "app-beta" }), hit({ window_start: T0 + 5 * MIN })]) {
      expect(await app.db.tx((q) => upsertCaseHit(q, h, T0))).toEqual({ created: true });
    }
    expect(await hits()).toHaveLength(4);
  });
});
