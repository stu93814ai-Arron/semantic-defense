import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import { RETENTION_MS, ensureFlowSchema, insertFlow, purgeExpired, recordRejection, type FlowDb } from "../src/write.js";
import { openSchemaDb } from "./helpers.js";

/** flow-store 直接呼叫（自 sensor-ingest store.test 搬來的護欄＋insertFlow 直測）。獨立 schema，不與其他測試互相清表。 */
let h: Awaited<ReturnType<typeof openSchemaDb>>;
let db: FlowDb;
beforeAll(async () => { h = await openSchemaDb("flow_store_test"); db = h.db; });
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await h.exec("DROP TABLE IF EXISTS flow_events");
  await h.exec("DROP TABLE IF EXISTS flow_rejections");
  await ensureFlowSchema(db);
});

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

describe("7 天清除（年齡 ≥ 7d 刪）", () => {
  it("RETENTION_MS = 7 * 24 * 60 * 60 * 1000", () => {
    expect(RETENTION_MS).toBe(604_800_000);
  });

  it("flow_events／flow_rejections：剛好 7 天 → 刪；略少 → 留；略多 → 刪（同一 cutoff，回兩表總數）", async () => {
    const keep = flow();
    for (const [f, at] of [[flow(), T0 - 1], [flow(), T0], [keep, T0 + 1]] as const) {
      await insertFlow(db, f, "s-1", at);
      await recordRejection(db, "s-1", at);
    }
    expect(await purgeExpired(db, T0 + RETENTION_MS)).toBe(4);
    expect((await ids()).map((r) => r.flow_id)).toEqual([keep.flow_id]);
    const left = await db.query<{ at: string }>("SELECT at FROM flow_rejections ORDER BY at");
    expect(left.rows.map((r) => Number(r.at))).toEqual([T0 + 1]);
  });
});

describe("flow_rejections 主鍵", () => {
  it("欄位只有 id（BIGSERIAL PK）、sensor_id、at；不記 payload", async () => {
    const cols = await db.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'flow_rejections' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual(["id", "sensor_id", "at"]);
    expect(cols.rows[0]!.column_default).toMatch(/^nextval\(/);
  });

  it("同一 sensor 同一 ms 被拒兩次 → 兩筆都保留", async () => {
    await recordRejection(db, "sensor-dup", T0);
    await recordRejection(db, "sensor-dup", T0);
    const r = await db.query<{ id: string }>("SELECT id FROM flow_rejections WHERE sensor_id = 'sensor-dup'");
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(2);
  });
});
