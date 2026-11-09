import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import { createFlowTables, insertFlowEvents } from "@semantic-defense/flow-store/testing";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { JUDGE_LOCK, runJudgeTick } from "../src/judge.js";
import { writeAutoBlocklistEntry } from "../src/auto-blacklist.js";

/** 成案流程 commit 7：判定 tick（計畫 §1／§2）。flow_events 以 ./testing 入口建表、塞資料（ADR 0001 補充）。 */
let app: ControlApi;
let lines: string[] = [];
afterEach(async () => { if (app) await app.close(); });

const T0 = Date.parse("2026-11-09T00:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const log = { warn: (obj: object, msg: string) => { lines.push(JSON.stringify({ ...obj, msg })); } };
async function boot(opts: { judgeIntervalMs?: number } = {}): Promise<ControlApi> {
  lines = [];
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => T0, ...opts });
  await seedPhase2Fixtures(app);
  await app.db.exec("DROP TABLE IF EXISTS flow_events, flow_rejections");
  await createFlowTables(app.db);
  return app;
}
/** 可疑：同一來源打 30 個 port、短連線無回應、低封包 → confidence 1.0；正常：3 筆同 port → 低分。 */
const flow = (src_ip: string, ts: number, dst_port: number, susp: boolean): FlowMetadataEvent => ({
  flow_id: randomUUID(), app_id: "app-1", ts: new Date(ts).toISOString(), src_ip, dst_ip: "10.0.0.1",
  src_port: 50000, dst_port, protocol: "tcp", bytes_in: 10, bytes_out: susp ? 0 : 500,
  packets: susp ? 1 : 20, duration_ms: susp ? 10 : 2000,
});
const scan = (ip: string, ts: number, receivedAt: number, n = 30, sensorId = "s-1") => insertFlowEvents(app.db,
  Array.from({ length: n }, (_, i) => ({ flow: flow(ip, ts, 1000 + i, true), sensorId, receivedAt })));
const normal = (ip: string, ts: number) => insertFlowEvents(app.db,
  Array.from({ length: 3 }, () => ({ flow: flow(ip, ts, 443, false), sensorId: "s-1", receivedAt: ts })));
const cases = async () => (await app.db.query<{ ip: string; hit_count: number; has_late: boolean; max_confidence: number }>(
  "SELECT ip, hit_count, has_late, max_confidence FROM blacklist_cases WHERE state = 'open' ORDER BY ip")).rows;
const hits = async () => (await app.db.query<{ src_ip: string; sensor_id: string; window_start: string; ontime_confidence: number | null }>(
  "SELECT src_ip, sensor_id, window_start, ontime_confidence FROM case_hits ORDER BY src_ip, sensor_id")).rows;
const cursor = async () => (await app.db.query<{ received_upto: string }>("SELECT received_upto FROM judge_cursor")).rows;

describe("判定 tick", () => {
  it("可疑 IP 成案、正常流量不成案；依 sensor 分開成命中；cursor 前進到 now", async () => {
    await boot();
    await scan("203.0.113.5", T0 - 2 * MIN, T0 - 2 * MIN);
    await scan("203.0.113.5", T0 - 2 * MIN, T0 - MIN, 30, "s-2");
    await normal("198.51.100.9", T0 - 2 * MIN);
    expect(await runJudgeTick(app.db, T0)).toMatchObject({ ran: true });
    expect(await cases()).toEqual([{ ip: "203.0.113.5/32", hit_count: 2, has_late: false, max_confidence: 1 }]);
    expect((await hits()).map((h) => [h.src_ip, h.sensor_id, Number(h.window_start), h.ontime_confidence])).toEqual([
      ["203.0.113.5/32", "s-1", T0 - 5 * MIN, 1], ["203.0.113.5/32", "s-2", T0 - 5 * MIN, 1]]);
    expect(await cursor()).toEqual([{ received_upto: String(T0) }]);
  });

  it("同一批資料重跑 tick（含 60 秒重疊）→ hit_count、命中數不變（冪等）", async () => {
    await boot();
    await scan("203.0.113.5", T0 - 2 * MIN, T0 - 30_000);
    await runJudgeTick(app.db, T0);
    await runJudgeTick(app.db, T0);
    await runJudgeTick(app.db, T0 + 10_000);
    expect((await cases()).map((c) => c.hit_count)).toEqual([1]);
    expect(await hits()).toHaveLength(1);
  });

  it("較晚 commit、received_at 落在 cursor 前 60 秒內的列，下一次 tick 仍會掃到", async () => {
    await boot();
    await runJudgeTick(app.db, T0);
    await scan("203.0.113.6", T0 - 2 * MIN, T0 - 50_000);
    await runJudgeTick(app.db, T0 + 5_000);
    expect((await cases()).map((c) => c.ip)).toEqual(["203.0.113.6/32"]);
  });

  it("全部遲到的組 → 照樣成案（has_late），ontime_confidence=NULL", async () => {
    await boot();
    await scan("203.0.113.7", T0 - 20 * MIN, T0 - MIN);
    await runJudgeTick(app.db, T0);
    expect(await cases()).toEqual([{ ip: "203.0.113.7/32", hit_count: 1, has_late: true, max_confidence: 1 }]);
    expect((await hits())[0]!.ontime_confidence).toBeNull();
  });

  it("另一個 tick 持有 advisory lock 時 → 不處理（ran:false、cursor 不動）", async () => {
    await boot();
    await scan("203.0.113.5", T0 - 2 * MIN, T0 - MIN);
    const r = await app.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock($1)", [JUDGE_LOCK]);
      return runJudgeTick(app.db, T0);
    });
    expect(r).toMatchObject({ ran: false });
    expect([await cases(), await cursor()]).toEqual([[], []]);
  });

  it("沒有 flow_events 表 → no-op，不建表", async () => {
    await boot();
    await app.db.exec("DROP TABLE flow_events");
    expect(await runJudgeTick(app.db, T0)).toMatchObject({ ran: false });
    expect((await app.db.query<{ ok: boolean }>("SELECT to_regclass('flow_events') IS NULL AS ok")).rows[0]!.ok).toBe(true);
  });

  it("清除：7 天前的命中、resolved_at 滿 7 天的已結案 case；未滿與 open 的保留", async () => {
    await boot();
    const hit = (ip: string, at: number) => app.db.query(
      "INSERT INTO case_hits VALUES ($1, 's-1', 'app-1', $2, 0.6, 0.6, $2, $2)", [ip, at]);
    await hit("203.0.113.1/32", T0 - 7 * DAY);
    await hit("203.0.113.2/32", T0 - 7 * DAY + 1);
    const kase = (ip: string, state: string, created: number) => app.db.query(
      `INSERT INTO blacklist_cases (case_id, ip, state, max_confidence, hit_count, created_at, expires_at, last_hit_at, resolved_at)
       VALUES ($1, $2, $3, 0.6, 1, $4, $5, $4, $6)`,
      [randomUUID(), ip, state, created, created + DAY, state === "open" ? null : created + DAY]);
    await kase("203.0.113.3/32", "expired", T0 - 8 * DAY);
    await kase("203.0.113.4/32", "rejected", T0 - 8 * DAY + 1);
    await kase("203.0.113.5/32", "open", T0 - 8 * DAY);
    await runJudgeTick(app.db, T0);
    expect((await hits()).map((h) => h.src_ip)).toEqual(["203.0.113.2/32"]);
    expect((await app.db.query<{ ip: string }>("SELECT ip FROM blacklist_cases ORDER BY ip")).rows.map((r) => r.ip))
      .toEqual(["203.0.113.4/32", "203.0.113.5/32"]);
  });
});

describe("門檻 fail-closed 在判定路徑寫 log.warn（資安 R3 補缺）", () => {
  async function legacyThresholds(): Promise<void> {
    await app.db.exec("DROP TABLE thresholds");
    await app.db.exec(`CREATE TABLE thresholds (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      case_threshold DOUBLE PRECISION NOT NULL, auto_threshold DOUBLE PRECISION NOT NULL)`);
    await app.db.query("INSERT INTO thresholds VALUES (TRUE, 0, 0)");
  }
  afterEach(async () => { await app?.db.exec("DROP TABLE IF EXISTS thresholds"); });

  it("tick：舊表 {0,0} → 以 0.50 判定（正常流量不成案），並經 tick 的 logger 寫 warn", async () => {
    await boot();
    await legacyThresholds();
    await normal("198.51.100.9", T0 - 2 * MIN);
    await runJudgeTick(app.db, T0, log);
    expect(await cases()).toEqual([]);
    expect(lines.filter((l) => l.includes("violation"))).toHaveLength(1);
  });

  it("自動上榜路徑：傳入 logger 時同樣寫 warn", async () => {
    await boot();
    await legacyThresholds();
    const r = await writeAutoBlocklistEntry(app.db, { ip: "203.0.113.9", confidence: 0.5, case_id: randomUUID() }, T0, log);
    expect(r).toEqual({ status: "below_auto_threshold" });
    expect(lines.filter((l) => l.includes("violation"))).toHaveLength(1);
  });
});

describe("buildApp 排程", () => {
  it("judgeIntervalMs>0 → 定期跑 tick（close 時清 timer）", async () => {
    await boot({ judgeIntervalMs: 20 });
    await scan("203.0.113.5", T0 - 2 * MIN, T0 - 30_000);
    await expect.poll(async () => (await cases()).map((c) => c.ip), { timeout: 5_000 }).toEqual(["203.0.113.5/32"]);
    expect(await cursor()).toEqual([{ received_upto: String(T0) }]);
  });
});
