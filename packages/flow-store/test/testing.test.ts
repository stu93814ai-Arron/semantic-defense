import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import { flowEventsReady, type FlowDb } from "../src/read.js";
import { createFlowTables, insertFlowEvents, insertLegacyFlowEvents } from "../src/testing.js";
import { openSchemaDb } from "./helpers.js";

/** 測試入口 ./testing（A 組領航員 11-09）：只有建表與塞資料的測試輔助，DDL 仍走 write.ts。 */
let h: Awaited<ReturnType<typeof openSchemaDb>>;
let db: FlowDb;
beforeAll(async () => { h = await openSchemaDb("flow_store_testing_test"); db = h.db; });
afterAll(async () => { await h?.close(); });

const flow = (src_ip: string): FlowMetadataEvent => ({
  flow_id: randomUUID(), app_id: "app-1", ts: "2026-11-05T12:00:00Z", src_ip, dst_ip: "10.0.0.1",
  src_port: 51234, dst_port: 443, protocol: "tcp", bytes_in: 10, bytes_out: 20, packets: 3, duration_ms: 5,
});

describe("flow-store/testing", () => {
  it("createFlowTables 建出 flow_events（可重複呼叫）", async () => {
    expect(await flowEventsReady(db)).toBe(false);
    await createFlowTables(db);
    await createFlowTables(db);
    expect(await flowEventsReady(db)).toBe(true);
  });

  it("insertFlowEvents 依序寫入並回實際新增筆數（同 sensor 重複 flow_id 不計）", async () => {
    await createFlowTables(db);
    const a = flow("203.0.113.5");
    const n = await insertFlowEvents(db, [
      { flow: a, sensorId: "s-1", receivedAt: 1000 },
      { flow: a, sensorId: "s-1", receivedAt: 2000 },
      { flow: flow("2001:db8::1"), sensorId: "s-2", receivedAt: 3000 },
    ]);
    expect(n).toBe(2);
    const rows = (await db.query<{ src_ip: string; sensor_id: string; received_at: string }>(
      "SELECT src_ip, sensor_id, received_at FROM flow_events ORDER BY received_at",
    )).rows;
    expect(rows.map((r) => [r.src_ip, r.sensor_id, Number(r.received_at)])).toEqual([
      ["203.0.113.5", "s-1", 1000], ["2001:db8::1", "s-2", 3000],
    ]);
  });

  it("insertLegacyFlowEvents：模擬舊版 ingest（ts_ms NULL），其餘同 insertFlowEvents", async () => {
    await createFlowTables(db);
    const a = flow("64.0.113.7");
    expect(await insertLegacyFlowEvents(db, [{ flow: a, sensorId: "s-9", receivedAt: 1 }, { flow: a, sensorId: "s-9", receivedAt: 2 }])).toBe(1);
    const r = await db.query<{ ts: string; ts_ms: string | null }>("SELECT ts, ts_ms FROM flow_events WHERE sensor_id = 's-9'");
    expect(r.rows).toEqual([{ ts: a.ts, ts_ms: null }]);
  });
});
