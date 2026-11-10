import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import { RETENTION_MS, REJECTION_COUNT_WINDOW_MS, REJECTION_RESERVED, REJECTION_UNBOUND_APP,
  countRejections, ensureFlowSchema, insertFlow, purgeExpired, recordRejection, type FlowDb } from "../src/write.js";
import { useSchemaDb } from "./helpers.js";

/** flow-store 直接呼叫（自 sensor-ingest store.test 搬來的護欄＋insertFlow 直測）。獨立 schema，不與其他測試互相清表。 */
const ref = useSchemaDb("flow_store_test", ["DROP TABLE IF EXISTS flow_events", "DROP TABLE IF EXISTS flow_rejections"]);
let db: FlowDb;
beforeEach(async () => { db = ref.h.db; await ensureFlowSchema(db); });

const T0 = 1_800_000_000_000;
const flow = (): FlowMetadataEvent => ({
  flow_id: randomUUID(), app_id: "app-1", ts: "2026-11-05T12:00:00Z", src_ip: "203.0.113.5", dst_ip: "10.0.0.1",
  src_port: 51234, dst_port: 443, protocol: "tcp", bytes_in: 10, bytes_out: 20, packets: 3, duration_ms: 5,
});
const ids = async () =>
  (await db.query<{ flow_id: string; sensor_id: string }>("SELECT flow_id, sensor_id FROM flow_events ORDER BY received_at")).rows;

describe("insertFlow", () => {
  it("PK (sensor_id, flow_id)：同 sensor 重複 → false；不同 sensor 同 flow_id → true", async () => {
    const f = flow();
    expect(await insertFlow(db, f, "s-1", T0)).toBe(true);
    expect(await insertFlow(db, f, "s-1", T0)).toBe(false);
    expect(await insertFlow(db, f, "s-2", T0)).toBe(true);
    expect((await ids()).map((r) => r.sensor_id).sort()).toEqual(["s-1", "s-2"]);
  });
});

describe("insertFlow 寫 ts_ms（Q1：JS Date.parse；與 SQL 回填 flow_ts_ms 同值）", () => {
  const TS = ["2026-11-05T12:00:00Z", "2026-11-05T20:00:00+08:00", "2026-11-05T12:00:00+15:59", "2026-11-05T12:00:00-15:59",
    "2026-11-05T12:00:00.123456Z", "2028-02-29T23:59:59.999999-03:30"];

  it("JS 寫入值 ＝ Date.parse ＝ 同列 flow_ts_ms(ts) 回填值", async () => {
    for (const ts of TS) await insertFlow(db, { ...flow(), ts }, "s-1", T0);
    const r = await db.query<{ ts: string; js: string; sql: string }>("SELECT ts, ts_ms AS js, flow_ts_ms(ts) AS sql FROM flow_events");
    expect(r.rows.map((x) => [x.ts, Number(x.js), Number(x.sql)]).sort())
      .toEqual(TS.map((ts) => [ts, Date.parse(ts), Date.parse(ts)]).sort());
  });

  it("Date.parse 不出數字（NaN）→ ts_ms NULL，照常寫入", async () => {
    expect(await insertFlow(db, { ...flow(), ts: "not-a-time" }, "s-1", T0)).toBe(true);
    expect((await db.query<{ ts_ms: string | null }>("SELECT ts_ms FROM flow_events")).rows).toEqual([{ ts_ms: null }]);
  });
});

describe("7 天清除（年齡 ≥ 7d 刪）", () => {
  it("RETENTION_MS = 7 * 24 * 60 * 60 * 1000", () => {
    expect(RETENTION_MS).toBe(604_800_000);
  });

  it("flow_events／flow_rejections：剛好 7 天 → 刪；略少 → 留；略多 → 刪（同一 cutoff，回兩表總數）", async () => {
    const keep = flow();
    for (const [f, at] of [[flow(), T0 - 1], [flow(), T0], [keep, T0 + 1]] as const) {
      await insertFlow(db, f, "s-1", at);
      await recordRejection(db, "s-1", at, REJECTION_UNBOUND_APP);
    }
    expect(await purgeExpired(db, T0 + RETENTION_MS)).toBe(4);
    expect((await ids()).map((r) => r.flow_id)).toEqual([keep.flow_id]);
    const left = await db.query<{ at: string }>("SELECT at FROM flow_rejections ORDER BY at");
    expect(left.rows.map((r) => Number(r.at))).toEqual([T0 + 1]);
  });
});

describe("flow_rejections 主鍵", () => {
  it("欄位為 id（BIGSERIAL PK）、sensor_id、at、reason；不記 payload", async () => {
    const cols = await db.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'flow_rejections' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual(["id", "sensor_id", "at", "reason"]);
    expect(cols.rows[0]!.column_default).toMatch(/^nextval\(/);
  });

  it("同一 sensor 同一 ms 被拒兩次 → 兩筆都保留", async () => {
    await recordRejection(db, "sensor-dup", T0, REJECTION_UNBOUND_APP);
    await recordRejection(db, "sensor-dup", T0, REJECTION_UNBOUND_APP);
    const r = await db.query<{ id: string }>("SELECT id FROM flow_rejections WHERE sensor_id = 'sensor-dup'");
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(2);
  });
});

describe("flow_rejections.reason（A 組領航員裁示；總召 §21:09 R10）", () => {
  it("欄位含 reason，不記 payload／位址", async () => {
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'flow_rejections' ORDER BY ordinal_position`);
    expect(cols.rows.map((c) => c.column_name)).toEqual(["id", "sensor_id", "at", "reason"]);
  });

  it("recordRejection 寫入指定 reason；值不含位址", async () => {
    await recordRejection(db, "s-1", T0, REJECTION_RESERVED);
    const r = await db.query<{ sensor_id: string; at: string; reason: string }>(
      "SELECT sensor_id, at, reason FROM flow_rejections");
    expect(r.rows).toEqual([{ sensor_id: "s-1", at: String(T0), reason: REJECTION_RESERVED }]);
    expect(r.rows[0]!.reason).toBe("reserved");
    expect(r.rows[0]!.reason).not.toMatch(/\d|:/);
  });

  it("既有表缺 reason 時，ensureFlowSchema 補欄，舊列預設 unbound_app", async () => {
    await db.query("ALTER TABLE flow_rejections DROP COLUMN reason");
    await db.query("INSERT INTO flow_rejections (sensor_id, at) VALUES ('s-old', $1)", [T0]);
    await ensureFlowSchema(db);
    const r = await db.query<{ sensor_id: string; reason: string }>("SELECT sensor_id, reason FROM flow_rejections");
    expect(r.rows).toEqual([{ sensor_id: "s-old", reason: REJECTION_UNBOUND_APP }]);
  });

  it("countRejections 只計窗口內指定 reason（24h）", async () => {
    expect(REJECTION_COUNT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    await recordRejection(db, "s-1", T0 - REJECTION_COUNT_WINDOW_MS - 1, REJECTION_RESERVED);
    await recordRejection(db, "s-1", T0 - REJECTION_COUNT_WINDOW_MS, REJECTION_RESERVED);
    await recordRejection(db, "s-1", T0, REJECTION_RESERVED);
    await recordRejection(db, "s-1", T0, REJECTION_UNBOUND_APP);
    expect(await countRejections(db, T0, REJECTION_RESERVED)).toBe(2);
  });
});
