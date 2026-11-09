import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureFlowSchema, type FlowDb } from "../src/write.js";
import { useSchemaDb, type SchemaDb } from "./helpers.js";

/**
 * ts_ms slice commit 1（計畫 /workspace/plans/ts-ms-slice-plan.md；A 核准 Q1–Q8）：flow_events.ts_ms 遷移。
 * 舊表＝現行 schema 去掉 ts_ms 欄、flow_ts_ms 函式、flow_events_group_ms 索引（測試不寫 DDL，boundary.test 鎖住）。
 */
const RESET = ["DROP TABLE IF EXISTS flow_events", "DROP TABLE IF EXISTS flow_rejections", "DROP FUNCTION IF EXISTS flow_ts_ms(TEXT)"];
const ref = useSchemaDb("flow_store_migration", RESET);
let h: SchemaDb;
let db: FlowDb;
beforeEach(() => { h = ref.h; db = h.db; });

const toLegacy = async () => {
  await h.exec("DROP INDEX IF EXISTS flow_events_group_ms");
  await h.exec("ALTER TABLE flow_events DROP COLUMN IF EXISTS ts_ms");
  await h.exec("DROP FUNCTION IF EXISTS flow_ts_ms(TEXT)");
};
const putRaw = (ts: string) => h.exec(
  `INSERT INTO flow_events (flow_id, app_id, ts, src_ip, dst_ip, src_port, dst_port, protocol, bytes_in, bytes_out,
     packets, duration_ms, sensor_id, received_at) VALUES ('${randomUUID()}', 'app-1', '${ts}', '64.0.113.5', '64.0.113.9',
     1, 2, 'tcp', 0, 0, 1, 0, 's-1', 1)`);
const tsMs = async () => (await db.query<{ ts: string; ts_ms: string | null }>("SELECT ts, ts_ms FROM flow_events ORDER BY ts")).rows
  .map((r) => [r.ts, r.ts_ms === null ? null : Number(r.ts_ms)]);

const VALID = "2026-11-05T12:00:00Z";
const POISON = ["0000-01-01T00:00:00Z", "2026-11-05T12:00:00+23:59", "2026-11-05T12:00:00-23:59"];

describe("ts_ms 遷移（舊表補欄＋回填）", () => {
  it("舊表：補 ts_ms BIGINT NULL；合法 ts 回填＝Date.parse，0000 年／±23:59 回填 NULL、不中斷遷移", async () => {
    await ensureFlowSchema(db);
    await toLegacy();
    for (const ts of [VALID, ...POISON]) await putRaw(ts);
    await ensureFlowSchema(db);
    expect(await tsMs()).toEqual([
      [POISON[0], null], [POISON[1], null], [POISON[2], null], [VALID, Date.parse(VALID)]]);
    const col = await db.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'flow_events' AND column_name = 'ts_ms'`);
    expect(col.rows).toEqual([{ data_type: "bigint", is_nullable: "YES" }]);
  });

  it("冪等：重跑不報錯、不改既有值；之後新寫的 NULL 列（滾動升級期間）在下次啟動補上", async () => {
    await ensureFlowSchema(db);
    await putRaw(VALID);
    await ensureFlowSchema(db);
    await ensureFlowSchema(db);
    expect(await tsMs()).toEqual([[VALID, Date.parse(VALID)]]);
  });

  it("並行 ensureFlowSchema（新表、舊表各 10 個 × 5 輪）全部成功（advisory xact lock 串行化）", async () => {
    const burst = () => Promise.all(Array.from({ length: 10 }, () => ensureFlowSchema(db)));
    for (let round = 0; round < 5; round += 1) {
      for (const sql of RESET) await h.exec(sql);
      await burst();
      await toLegacy();
      await putRaw(VALID);
      await burst();
      expect(await tsMs()).toEqual([[VALID, Date.parse(VALID)]]);
    }
  });

  it("索引 flow_events_group_ms (sensor_id, app_id, src_ip, ts_ms) 存在且為完整索引（非 partial，Q7）", async () => {
    await ensureFlowSchema(db);
    const r = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'flow_events_group_ms'");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.indexdef).toMatch(/\(sensor_id, app_id, src_ip, ts_ms\)$/);
  });
});

describe("R-A：flow_ts_ms 遇 'infinity'／'-infinity'（0A000 feature_not_supported）回 NULL，不讓遷移回滾", () => {
  it("舊列 ts='infinity'／'-infinity'（ts_ms NULL）→ ensureFlowSchema 成功、兩列 ts_ms 仍為 NULL，合法列照常回填", async () => {
    await ensureFlowSchema(db);
    await toLegacy();
    for (const ts of ["infinity", "-infinity", VALID]) await putRaw(ts);
    await ensureFlowSchema(db);
    expect(await tsMs()).toEqual([["-infinity", null], [VALID, Date.parse(VALID)], ["infinity", null]]);
  });

  it("handler 只列 data_exception 與 feature_not_supported（不得改成 WHEN OTHERS 吞掉所有錯誤）", async () => {
    await ensureFlowSchema(db);
    const r = await db.query<{ prosrc: string }>(
      "SELECT prosrc FROM pg_proc WHERE proname = 'flow_ts_ms' AND pronamespace = current_schema()::regnamespace");
    expect(r.rows).toHaveLength(1); // 同名只有一個：不得另有 overload（例如帶 WHEN OTHERS 的版本）而本測試只看到其中一個
    // 先去掉 SQL 註解（-- 行尾、/* */），註解裡的 WHEN … THEN 不算 handler
    const src = r.rows[0]!.prosrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    const handlers = [...src.matchAll(/WHEN\s+([\s\S]*?)\s+THEN/gi)].map((m) => m[1]!.split(/\s+OR\s+/i).map((c) => c.trim().toLowerCase()));
    expect(handlers).toEqual([["data_exception", "feature_not_supported"]]);
  });
});

describe("舊索引 flow_events_group (…, ts) 移除（Q3：grep 確認沒有查詢依 ts 文字過濾／排序）", () => {
  const indexes = async () => (await db.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'flow_events' ORDER BY indexname")).rows
    .map((r) => r.indexname);
  const FINAL = ["flow_events_group_ms", "flow_events_pkey", "flow_events_received_at"];

  it("新表沒有舊索引；舊表（帶舊索引）啟動後被移除；重跑冪等", async () => {
    await ensureFlowSchema(db);
    expect(await indexes()).toEqual(FINAL);
    await toLegacy();
    // 測試不寫 DDL（boundary.test）：把現有索引改名成舊名，模擬舊版留下的 flow_events_group（DROP 依名稱）
    await h.exec("ALTER INDEX flow_events_received_at RENAME TO flow_events_group");
    expect(await indexes()).toContain("flow_events_group");
    await ensureFlowSchema(db);
    await ensureFlowSchema(db);
    expect(await indexes()).toEqual(FINAL);
  });
});

describe("flow_ts_ms(TEXT)：與 JS Date.parse 一致（Q1）", () => {
  const SAME = [
    "2026-11-05T12:00:00Z", "2026-11-05T12:00:00.123Z", "2026-11-05T20:00:00+08:00", "2026-11-05T12:00:00+15:59",
    "2026-11-05T12:00:00-15:59", "2026-11-05T12:00:00.123456Z", "2026-11-05T12:00:00.999999+08:00",
    "2028-02-29T23:59:59.5Z", "2024-02-29T00:00:00-03:30",
  ];

  it.each(SAME)("%s → SQL 值 = Date.parse（6 位小數 floor 到 ms）", async (ts) => {
    await ensureFlowSchema(db);
    const r = await db.query<{ v: string }>("SELECT flow_ts_ms($1) AS v", [ts]);
    expect(Number(r.rows[0]!.v)).toBe(Date.parse(ts));
  });

  it("只吞 data_exception → NULL；STABLE（非 IMMUTABLE）", async () => {
    await ensureFlowSchema(db);
    const r = await db.query<{ v: string | null }>("SELECT flow_ts_ms($1) AS v", ["not-a-time"]);
    expect(r.rows[0]!.v).toBeNull();
    const f = await db.query<{ provolatile: string }>(
      "SELECT provolatile FROM pg_proc WHERE proname = 'flow_ts_ms' AND pronamespace = current_schema()::regnamespace");
    expect(f.rows).toEqual([{ provolatile: "s" }]);
  });
});
