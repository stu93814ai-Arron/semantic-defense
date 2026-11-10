import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { insertFlowEvents, insertLegacyFlowEvents } from "@semantic-defense/flow-store/testing";
import type { ControlApi } from "./helpers/app.js";
import { DAY, MIN, T0, auditIndexDefAfterReinit, bootJudgeApp, flowEvent as flow } from "./helpers/judge.js";
import { JUDGE_LOCK, runJudgeTick } from "../src/judge.js";
import { writeAutoBlocklistEntry } from "./helpers/auto-list.js";

/** 成案流程 commit 7：判定 tick（計畫 §1／§2）。flow_events 以 ./testing 入口建表、塞資料（ADR 0001 補充）。 */
let app: ControlApi;
let lines: string[] = [];
afterEach(async () => { if (app) await app.close(); });

const log = { warn: (obj: object, msg: string) => { lines.push(JSON.stringify({ ...obj, msg })); }, error: (obj: object, msg: string) => { lines.push(JSON.stringify({ ...obj, msg })); } };
async function boot(opts: { judgeIntervalMs?: number } = {}): Promise<ControlApi> {
  lines = [];
  app = await bootJudgeApp(opts);
  return app;
}
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
  it("可疑 IP 成案、正常流量不成案；依 sensor 分開成命中；cursor 前進到看到的最大 received_at", async () => {
    await boot();
    await scan("64.0.113.5", T0 - 2 * MIN, T0 - 2 * MIN);
    await scan("64.0.113.5", T0 - 2 * MIN, T0 - MIN, 30, "s-2");
    await normal("198.51.99.9", T0 - 2 * MIN);
    expect(await runJudgeTick(app.db, T0)).toMatchObject({ ran: true });
    expect(await cases()).toEqual([{ ip: "64.0.113.5/32", hit_count: 2, has_late: false, max_confidence: 1 }]);
    expect((await hits()).map((h) => [h.src_ip, h.sensor_id, Number(h.window_start), h.ontime_confidence])).toEqual([
      ["64.0.113.5/32", "s-1", T0 - 5 * MIN, 1], ["64.0.113.5/32", "s-2", T0 - 5 * MIN, 1]]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - MIN) }]);
  });

  it("同一批資料重跑 tick（含 60 秒重疊）→ hit_count、命中數不變（冪等）", async () => {
    await boot();
    await scan("64.0.113.5", T0 - 2 * MIN, T0 - 30_000);
    await runJudgeTick(app.db, T0);
    await runJudgeTick(app.db, T0);
    await runJudgeTick(app.db, T0 + 10_000);
    expect((await cases()).map((c) => c.hit_count)).toEqual([1]);
    expect(await hits()).toHaveLength(1);
  });

  it("較晚 commit、received_at 落在 cursor 前 60 秒內的列，下一次 tick 仍會掃到", async () => {
    await boot();
    await runJudgeTick(app.db, T0);
    await scan("64.0.113.6", T0 - 2 * MIN, T0 - 50_000);
    await runJudgeTick(app.db, T0 + 5_000);
    expect((await cases()).map((c) => c.ip)).toEqual(["64.0.113.6/32"]);
  });

  it("全部遲到的組 → 照樣成案（has_late），ontime_confidence=NULL", async () => {
    await boot();
    await scan("64.0.113.7", T0 - 20 * MIN, T0 - MIN);
    await runJudgeTick(app.db, T0);
    expect(await cases()).toEqual([{ ip: "64.0.113.7/32", hit_count: 1, has_late: true, max_confidence: 1 }]);
    expect((await hits())[0]!.ontime_confidence).toBeNull();
  });

  it("另一個 tick 持有 advisory lock 時 → 不處理（ran:false、cursor 不動）", async () => {
    await boot();
    await scan("64.0.113.5", T0 - 2 * MIN, T0 - MIN);
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
    await hit("64.0.113.1/32", T0 - 7 * DAY);
    await hit("64.0.113.2/32", T0 - 7 * DAY + 1);
    const kase = (ip: string, state: string, created: number) => app.db.query(
      `INSERT INTO blacklist_cases (case_id, ip, state, max_confidence, hit_count, created_at, expires_at, last_hit_at, resolved_at)
       VALUES ($1, $2, $3, 0.6, 1, $4, $5, $4, $6)`,
      [randomUUID(), ip, state, created, created + DAY, state === "open" ? null : created + DAY]);
    await kase("64.0.113.3/32", "expired", T0 - 8 * DAY);
    await kase("64.0.113.4/32", "rejected", T0 - 8 * DAY + 1);
    await kase("64.0.113.5/32", "open", T0 - DAY / 2); // 未到期的 open（過期的 open 會先被收成 expired，見修正 2）
    await runJudgeTick(app.db, T0);
    expect((await hits()).map((h) => h.src_ip)).toEqual(["64.0.113.2/32"]);
    expect((await app.db.query<{ ip: string }>("SELECT ip FROM blacklist_cases ORDER BY ip")).rows.map((r) => r.ip))
      .toEqual(["64.0.113.4/32", "64.0.113.5/32"]);
  });
});

describe("judge_cursor 依資料時間前進（A 組領航員修正 1）", () => {
  it("cursor 只依資料時間前進：沒有新列不動；ingest 時鐘慢 5 分鐘、較晚 commit 的列仍掃得到", async () => {
    await boot();
    await runJudgeTick(app.db, T0);
    expect(await cursor()).toEqual([]);
    await normal("198.51.99.9", T0 - 6 * MIN);
    await runJudgeTick(app.db, T0);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 6 * MIN) }]);
    // ingest 時鐘慢 5 分鐘：control-api 的 T0+10s 時，ingest 蓋的 received_at 只有 T0-5m+10s
    await scan("64.0.113.10", T0 - 6 * MIN, T0 - 5 * MIN + 10_000);
    await runJudgeTick(app.db, T0 + 10_000);
    expect((await cases()).map((c) => c.ip)).toEqual(["64.0.113.10/32"]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 5 * MIN + 10_000) }]);
  });
});

describe("過期 open case 每次 tick 全面收掉（A 組領航員修正 2）", () => {
  type Row = { ip: string; state: string; resolved_at: string | null; expires_at: string };
  const all = async () => (await app.db.query<Row>(
    "SELECT ip, state, resolved_at, expires_at FROM blacklist_cases ORDER BY ip")).rows;
  const open = (ip: string, created: number) => app.db.query(
    `INSERT INTO blacklist_cases (case_id, ip, state, max_confidence, hit_count, created_at, expires_at, last_hit_at)
     VALUES ($1, $2, 'open', 0.6, 1, $3, $4, $3)`, [randomUUID(), ip, created, created + DAY]);

  it("過期且沒再命中的 case → expired、resolved_at＝expires_at；未到期的維持 open", async () => {
    await boot();
    await open("64.0.113.1/32", T0 - DAY - 1);
    await open("64.0.113.2/32", T0 - DAY);
    await open("64.0.113.3/32", T0 - DAY + 1);
    await runJudgeTick(app.db, T0);
    expect((await all()).map((c) => [c.ip, c.state, c.resolved_at])).toEqual([
      ["64.0.113.1/32", "expired", String(T0 - 1)], ["64.0.113.2/32", "expired", String(T0)],
      ["64.0.113.3/32", "open", null]]);
  });

  it("收掉後滿 7 天（resolved_at＋7d）被清除；未滿的保留", async () => {
    await boot();
    await open("64.0.113.1/32", T0 - DAY);
    await open("64.0.113.2/32", T0 - DAY + 1);
    await runJudgeTick(app.db, T0);
    await runJudgeTick(app.db, T0 + 7 * DAY);
    expect((await all()).map((c) => [c.ip, c.state])).toEqual([["64.0.113.2/32", "expired"]]);
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
    await normal("198.51.99.9", T0 - 2 * MIN);
    await runJudgeTick(app.db, T0, log);
    expect(await cases()).toEqual([]);
    expect(lines.filter((l) => l.includes("violation"))).toHaveLength(1);
  });

  it("自動上榜路徑：傳入 logger 時同樣寫 warn", async () => {
    await boot();
    await legacyThresholds();
    const r = await writeAutoBlocklistEntry(app.db, { ip: "64.0.113.9", confidence: 0.5, case_id: randomUUID() }, T0, log);
    expect(r).toEqual({ status: "below_auto_threshold" });
    expect(lines.filter((l) => l.includes("violation"))).toHaveLength(1);
  });
});

describe("buildApp 排程", () => {
  it("judgeIntervalMs>0 → 定期跑 tick（close 時清 timer）", async () => {
    await boot({ judgeIntervalMs: 20 });
    await scan("64.0.113.5", T0 - 2 * MIN, T0 - 30_000);
    await expect.poll(async () => (await cases()).map((c) => c.ip), { timeout: 5_000 }).toEqual(["64.0.113.5/32"]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 30_000) }]);
  });
});

describe("重掃時待審 max 以 GREATEST 更新（A 組領航員裁定 11-09）", () => {
  type Full = { max_confidence: number; hit_count: number; expires_at: string; last_hit_at: string; state: string };
  const full = async () => (await app.db.query<Full>(
    "SELECT max_confidence, hit_count, expires_at, last_hit_at, state FROM blacklist_cases")).rows;
  const IP = "64.0.113.8";
  const W = T0 - 2 * MIN;
  const more = (n: number, susp: boolean, receivedAt: number, port0 = 2000) => insertFlowEvents(app.db,
    Array.from({ length: n }, (_, i) => ({ flow: flow(IP, W, susp ? port0 + i : 443, susp), sensorId: "s-1", receivedAt })));

  it("同一命中重掃分數變高（≈0.69→1.0）→ max 更新；hit_count、expires_at、last_hit_at 不變", async () => {
    await boot();
    await more(10, true, T0 - 50_000);
    await runJudgeTick(app.db, T0);
    const [before] = await full();
    expect(before!.max_confidence).toBeLessThan(0.8);
    await more(20, true, T0 + 10_000, 3000);
    await runJudgeTick(app.db, T0 + 20_000);
    expect(await full()).toEqual([{ ...before, max_confidence: 1 }]);
  });

  it("重掃分數變低（仍 ≥case）→ max 不降；命中明細記新分數", async () => {
    await boot();
    await more(30, true, T0 - 50_000);
    await runJudgeTick(app.db, T0);
    await more(10, false, T0 + 10_000);
    await runJudgeTick(app.db, T0 + 20_000);
    expect((await full()).map((c) => [c.max_confidence, c.hit_count])).toEqual([[1, 1]]);
    expect((await app.db.query<{ confidence: number }>("SELECT confidence FROM case_hits")).rows[0]!.confidence).toBeLessThan(1);
  });

  it("案件已不是 open → 重掃不更新，也不開新案", async () => {
    await boot();
    await more(10, true, T0 - 50_000);
    await runJudgeTick(app.db, T0);
    await app.db.query("UPDATE blacklist_cases SET state = 'rejected', resolved_at = $1", [T0 + 1]);
    const before = await full();
    await more(20, true, T0 + 10_000, 3000);
    await runJudgeTick(app.db, T0 + 20_000);
    expect(await full()).toEqual(before);
  });
});

describe("白名單 IP 不開案；已上榜 IP 只寫 hit_while_listed（commit 8）", () => {
  type Audit = { action: string; actor: string; sensor_id: string | null; detail: Record<string, unknown> };
  const audits = async () => (await app.db.query<Audit>(
    "SELECT action, actor, sensor_id, detail FROM audit_events WHERE action LIKE 'blacklist.%' ORDER BY id")).rows;
  const hitIps = async () => (await hits()).map((h) => h.src_ip);
  const allow = (cidr: string) => app.db.query(
    "INSERT INTO allowlist_entries VALUES ($1, $2, 'office', 'admin1', $3, NULL)", [randomUUID(), cidr, T0 - DAY]);
  /** 直接以 SQL 塞黑名單列（可塞 /24，繞過 insertActiveBlocklistEntry 的前綴護欄）。 */
  const listed = async (ip: string, o: { revoked?: boolean; ended?: boolean; expires?: number } = {}) => {
    const id = randomUUID();
    await app.db.query(
      `INSERT INTO blocklist_entries (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at, ended_at)
       VALUES ($1, $2, 'auto', 0.95, $3, $4, $5, 'system:auto', $4, $6, $7)`,
      [id, ip, randomUUID(), T0 - DAY / 2, o.expires ?? T0 + DAY / 2, o.revoked ? T0 - 1 : null, o.ended ? T0 - 1 : null]);
    return id;
  };

  it("白名單 /24 內的 IP 命中 → 存 case_hits、不開案、不寫稽核", async () => {
    await boot();
    await allow("64.0.113.0/24");
    await scan("64.0.113.5", T0 - 2 * MIN, T0 - MIN);
    await runJudgeTick(app.db, T0);
    expect([await hitIps(), await cases(), await audits()]).toEqual([["64.0.113.5/32"], [], []]);
  });

  it("已上榜 IP 再命中 → 存 case_hits、不開案、hit_while_listed 一筆；重掃不重寫、不延長", async () => {
    await boot();
    const entry = await listed("64.0.113.5/32");
    await scan("64.0.113.5", T0 - 2 * MIN, T0 - MIN, 30, "s-2");
    await runJudgeTick(app.db, T0);
    await runJudgeTick(app.db, T0 + 10_000);
    expect([await hitIps(), await cases()]).toEqual([["64.0.113.5/32"], []]);
    expect(await audits()).toEqual([{ action: "blacklist.hit_while_listed", actor: "system:auto", sensor_id: "s-2",
      detail: { ip: "64.0.113.5/32", entry_id: entry, app_id: "app-1",
        window_start: new Date(T0 - 5 * MIN).toISOString(), confidence: 1 } }]);
    expect((await app.db.query<{ expires_at: string }>("SELECT expires_at FROM blocklist_entries")).rows)
      .toEqual([{ expires_at: String(T0 + DAY / 2) }]);
  });

  it("hit_while_listed 同一 entry_id 每小時最多一筆（伺服器時間）；多出來的命中每個 tick 一行 log 記數量（資安退回 R5）", async () => {
    await boot();
    const entry = await listed("64.0.113.5/32");
    for (const w of [12, 7, 2]) await scan("64.0.113.5", T0 - w * MIN, T0 - MIN);
    await runJudgeTick(app.db, T0, log);
    await scan("64.0.113.5", T0 + 52 * MIN, T0 + 58 * MIN);
    await runJudgeTick(app.db, T0 + 59 * MIN, log);
    await scan("64.0.113.5", T0 + 59 * MIN, T0 + 59 * MIN + 30_000);
    await runJudgeTick(app.db, T0 + 60 * MIN, log);
    const rows = await app.db.query<{ at: string }>("SELECT at FROM audit_events WHERE action = 'blacklist.hit_while_listed' ORDER BY id");
    expect(rows.rows.map((r) => Number(r.at))).toEqual([T0, T0 + 60 * MIN]);
    expect((await audits()).every((a) => a.detail.entry_id === entry)).toBe(true);
    expect(lines.map((l) => JSON.parse(l) as object)).toEqual([2, 1].map((n) =>
      ({ suppressed: n, msg: "judge tick suppressed hit_while_listed audits (1 per entry per hour)" })));
  });

  it("「已上榜」只認 canonical IP 完全相等且生效：生效的 /24、已撤回、已結束、已到期 → 照常成案、不寫稽核", async () => {
    await boot();
    await listed("64.0.113.0/24");
    await listed("198.51.99.1/32", { revoked: true });
    await listed("198.51.99.2/32", { ended: true });
    await listed("198.51.99.3/32", { expires: T0 });
    for (const ip of ["64.0.113.9", "198.51.99.1", "198.51.99.2", "198.51.99.3"]) await scan(ip, T0 - 2 * MIN, T0 - MIN);
    await runJudgeTick(app.db, T0);
    expect((await cases()).map((c) => c.ip)).toEqual(["198.51.99.1/32", "198.51.99.2/32", "198.51.99.3/32", "64.0.113.9/32"]);
    expect(await audits()).toEqual([]);
  });
});

describe("保留位址的 src_ip（資安退回 B1）", () => {
  const RESERVED = ["127.0.0.1", "0.0.0.0", "224.0.0.1", "169.254.1.1", "fe80::1", "::1", "255.255.255.255"];

  it("同一批有保留位址與正常 IP → 保留位址整組跳過（不拋錯、不 rollback），正常 IP 仍成案、cursor 前進；log 只記數量不記 IP", async () => {
    await boot();
    for (const ip of RESERVED) await scan(ip, T0 - 2 * MIN, T0 - MIN);
    await scan("64.0.113.9", T0 - 2 * MIN, T0 - 30_000);
    await expect(runJudgeTick(app.db, T0, log)).resolves.toMatchObject({ ran: true, hits: 1 });
    expect((await cases()).map((c) => c.ip)).toEqual(["64.0.113.9/32"]);
    expect((await hits()).map((h) => h.src_ip)).toEqual(["64.0.113.9/32"]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 30_000) }]);
    expect(lines.map((l) => JSON.parse(l) as object)).toEqual([{ skipped: RESERVED.length, msg: "judge tick skipped non-host src_ip groups" }]);
    for (const ip of RESERVED) expect(lines.join("\n")).not.toContain(ip);
  });
});

describe("case_hits 7 天清除依 first_seen_at（資安退回 R3）", () => {
  it("命中第一次寫入後被重掃刷新 updated_at，+7 天的空 tick 仍會刪掉", async () => {
    await boot();
    await scan("64.0.113.10", T0 - 2 * MIN, T0 - MIN);
    await runJudgeTick(app.db, T0);
    await scan("64.0.113.10", T0 - 2 * MIN, T0 + 6 * DAY, 1);
    await runJudgeTick(app.db, T0 + 6 * DAY);
    const at = await app.db.query<{ first_seen_at: string; updated_at: string }>("SELECT first_seen_at, updated_at FROM case_hits");
    expect(at.rows).toEqual([{ first_seen_at: String(T0), updated_at: String(T0 + 6 * DAY) }]);
    await runJudgeTick(app.db, T0 + 7 * DAY);
    expect(await hits()).toEqual([]);
  });
});

describe("hit_while_listed 去重查詢的 partial index（資安退回 R5）", () => {
  it("audit_hit_while_listed_entry 已建立（action、detail->>'entry_id'、at；WHERE action）；重複初始化不報錯", async () => {
    await boot();
    expect(await auditIndexDefAfterReinit(app, "audit_hit_while_listed_entry")).toMatch(/\(action, \(\(detail ->> 'entry_id'::text\)\), at\) WHERE \(action = 'blacklist\.hit_while_listed'::text\)/);
  });
});

describe("判定只讀 ts_ms（ts slice；B2 改寫）：ts_ms NULL 的列不分組、只計數，cursor 照常前進", () => {
  const BAD_TS = ["0000-01-01T00:00:00Z", "2026-11-08T23:58:00+23:59", "2026-11-08T23:58:00-23:59"];
  const NULL_TS_MSG = "judge tick skipped rows without ts_ms";
  /** 舊列（ts_ms NULL）：Postgres 不收的 ts，模擬 ts_ms 之前就寫入、回填也算不出值的列。 */
  const poison = (n: number, receivedAt: number) => insertLegacyFlowEvents(app.db, Array.from({ length: n }, (_, i) => ({
    flow: { ...flow(`198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`, T0 - 2 * MIN, 1000, true), ts: BAD_TS[i % 3]! },
    sensorId: "s-1", receivedAt })));
  const logged = () => lines.map((l) => JSON.parse(l) as object);

  it("50 筆舊毒列排在佇列最前＋正常 IP 同批 → 正常 IP 成案、cursor 前進；log 只有 {null_ts:50}，不帶 IP／ts", async () => {
    await boot();
    await poison(50, T0 - 2 * MIN);
    await scan("64.0.113.11", T0 - 2 * MIN, T0 - 30_000);
    await expect(runJudgeTick(app.db, T0, log)).resolves.toMatchObject({ ran: true, hits: 1, groups: 1 });
    expect((await cases()).map((c) => c.ip)).toEqual(["64.0.113.11/32"]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 30_000) }]);
    expect(logged()).toEqual([{ null_ts: 50, msg: NULL_TS_MSG }]);
    for (const s of [...BAD_TS, "198.51.", "0000-01-01"]) expect(lines.join("\n")).not.toContain(s);
  });

  it("整批只有毒列 → 不成案、cursor 仍推到這批最大 received_at；重疊區再看到不重複計數", async () => {
    await boot();
    await poison(3, T0 - MIN);
    await runJudgeTick(app.db, T0, log);
    expect(await cases()).toEqual([]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - MIN) }]);
    await runJudgeTick(app.db, T0 + 1000, log);
    expect(logged()).toEqual([{ null_ts: 3, msg: NULL_TS_MSG }]);
  });

  it("ts_ms 已寫入、ts 為 +23:59 的列 → 依 ts_ms 正常判定（不再對 ts 做 ::timestamptz）", async () => {
    await boot();
    await insertFlowEvents(app.db, Array.from({ length: 30 }, (_, i) => ({
      flow: { ...flow("64.0.113.13", T0, 1000 + i, true), ts: BAD_TS[1]! }, sensorId: "s-1", receivedAt: T0 - MIN })));
    await runJudgeTick(app.db, T0, log);
    expect(await cases()).toEqual([{ ip: "64.0.113.13/32", hit_count: 1, has_late: true, max_confidence: 1 }]);
    expect(Number((await hits())[0]!.window_start)).toBe(Math.floor(Date.parse(BAD_TS[1]!) / (5 * MIN)) * 5 * MIN);
    expect(lines).toEqual([]);
  });
});

describe("只吞 SQLSTATE 22（data exception）；其他錯誤讓整個 tick rollback、cursor 不動（資安退回 B3）", () => {
  const IP = "64.0.113.12";
  /** 測試專用 trigger：寫這個 IP 的 case_hits 時丟指定 SQLSTATE（模擬 deadlock／lock_not_available）。 */
  const trap = (code: string) => app.db.exec(`
    CREATE OR REPLACE FUNCTION test_trap() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'trap' USING ERRCODE = '${code}'; END $$;
    CREATE TRIGGER test_trap BEFORE INSERT ON case_hits FOR EACH ROW WHEN (NEW.src_ip = '${IP}/32') EXECUTE FUNCTION test_trap();`);
  const untrap = () => app.db.exec("DROP TRIGGER test_trap ON case_hits; DROP FUNCTION test_trap()");

  it("trigger 丟 22008（data exception）→ 只回滾該組、記 {failed:1, codes}，cursor 照常前進（SAVEPOINT 保留，Q5）", async () => {
    await boot();
    await scan(IP, T0 - 2 * MIN, T0 - 30_000);
    await trap("22008");
    await expect(runJudgeTick(app.db, T0, log)).resolves.toMatchObject({ ran: true, hits: 0 });
    await untrap();
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 30_000) }]);
    expect(lines.map((l) => JSON.parse(l) as object)).toEqual([{ failed: 1, codes: { "22008": 1 }, msg: "judge tick rolled back failed groups" }]);
  });

  it.each(["40P01", "55P03"])("trigger 丟 %s → tick reject、cursor 不變、不寫 failed log；移除後下一個 tick 成案", async (code) => {
    await boot();
    await runJudgeTick(app.db, T0);
    await normal("198.51.99.9", T0 - 3 * MIN);
    await runJudgeTick(app.db, T0);
    const before = await cursor();
    await scan(IP, T0 - 2 * MIN, T0 - 30_000);
    await trap(code);
    const err = await runJudgeTick(app.db, T0 + 1000, log).catch((e: unknown) => e);
    expect(await cursor()).toEqual(before);
    expect(err).toMatchObject({ code });
    expect(lines).toEqual([]);
    await untrap();
    await runJudgeTick(app.db, T0 + 2000, log);
    expect((await cases()).map((c) => c.ip)).toEqual([`${IP}/32`]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 30_000) }]);
  });
});

describe("只吞 22007／22008／22009；其他錯誤整個 tick 回滾；全部組都 22 類失敗也照常前進（R14b 已移除，A 組領航員裁示 R18）", () => {
  const IP = "64.0.113.13";
  const trap = (code: string) => app.db.exec(`
    DROP TRIGGER IF EXISTS test_trap ON case_hits;
    CREATE OR REPLACE FUNCTION test_trap() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'trap' USING ERRCODE = '${code}'; END $$;
    CREATE TRIGGER test_trap BEFORE INSERT ON case_hits FOR EACH ROW WHEN (NEW.src_ip = '${IP}/32') EXECUTE FUNCTION test_trap();`);
  const seed = async () => {
    await boot();
    await normal("198.51.99.9", T0 - 3 * MIN);
    await runJudgeTick(app.db, T0);
    const before = await cursor();
    await scan(IP, T0 - 2 * MIN, T0 - 30_000);
    await normal("198.51.99.10", T0 - MIN);
    return before;
  };

  it.each(["22P02", "22012", "22023"])("22 類但非日期時間（%s）→ 往外丟、tick rollback、cursor 不變、不寫 failed log", async (code) => {
    const before = await seed();
    await trap(code);
    const err = await runJudgeTick(app.db, T0 + 1000, log).catch((e: unknown) => e);
    expect(err).toMatchObject({ code });
    expect(await cursor()).toEqual(before);
    expect(lines).toEqual([]);
  });

  it("22007 仍只回滾該組：其他組照常、cursor 前進、log {failed:1, codes:{22007:1}}", async () => {
    await seed();
    await trap("22007");
    await expect(runJudgeTick(app.db, T0 + 1000, log)).resolves.toMatchObject({ ran: true });
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 30_000) }]);
    expect(lines.map((l) => JSON.parse(l) as object)).toEqual([
      { failed: 1, codes: { "22007": 1 }, msg: "judge tick rolled back failed groups" }]);
  });

  it("1 組跳過（保留位址）＋其餘全部 22008 → tick 不拋、cursor 前進、各記一行數量（R14b 已移除）", async () => {
    await boot();
    await trap("22008");
    await scan(IP, T0 - 8 * MIN, T0 - MIN);
    await scan(IP, T0 - 2 * MIN, T0 - 30_000);
    await scan("127.0.0.1", T0 - 2 * MIN, T0 - 20_000);
    await expect(runJudgeTick(app.db, T0 + 1000, log)).resolves.toMatchObject({ ran: true, groups: 3, hits: 0 });
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 20_000) }]);
    expect(lines.map((l) => JSON.parse(l) as object)).toEqual([
      { skipped: 1, msg: "judge tick skipped non-host src_ip groups" },
      { failed: 2, codes: { "22008": 2 }, msg: "judge tick rolled back failed groups" }]);
  });

  it("這批每一組都 22 類日期時間錯誤（22007／22009）→ tick 不拋、cursor 前進、不留 case_hits；之後新列照常判定", async () => {
    await boot();
    await trap("22009");
    await scan(IP, T0 - 8 * MIN, T0 - MIN);
    await scan(IP, T0 - 2 * MIN, T0 - 30_000);
    await expect(runJudgeTick(app.db, T0 + 1000, log)).resolves.toMatchObject({ ran: true, groups: 2, hits: 0 });
    expect([await cursor(), await hits()]).toEqual([[{ received_upto: String(T0 - 30_000) }], []]);
    await trap("22007");
    await scan(IP, T0 - MIN, T0 - 10_000);
    await expect(runJudgeTick(app.db, T0 + 2000, log)).resolves.toMatchObject({ ran: true, hits: 0 });
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 10_000) }]);
    await app.db.exec("DROP TRIGGER test_trap ON case_hits");
    await scan("64.0.113.14", T0 - MIN, T0 - 5_000);
    await expect(runJudgeTick(app.db, T0 + 3000, log)).resolves.toMatchObject({ ran: true });
    expect((await cases()).map((c) => c.ip)).toContain("64.0.113.14/32");
    // 第 2 個 tick：新列一組＋60 秒重疊區重判上一批 T0−2m 那組 → 22007 兩組
    expect(lines.map((l) => (JSON.parse(l) as { codes?: object }).codes)).toEqual([{ "22009": 2 }, { "22007": 2 }]);
  });
});
