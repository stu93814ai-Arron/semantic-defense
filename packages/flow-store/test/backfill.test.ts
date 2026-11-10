import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import {
  FLOW_BACKFILL_BATCH, FLOW_DDL_LOCK_TIMEOUT, FLOW_INDEX_STATEMENT_TIMEOUT, FLOW_SCHEMA_LOCK,
  ensureFlowSchema, insertFlow, type FlowDb,
} from "../src/write.js";
import { useSchemaDb, type SchemaDb } from "./helpers.js";

const RESET = ["DROP TABLE IF EXISTS flow_events", "DROP TABLE IF EXISTS flow_rejections", "DROP FUNCTION IF EXISTS flow_ts_ms(TEXT)"];
const ref = useSchemaDb("flow_store_backfill", RESET);
let h: SchemaDb;
let db: FlowDb;
beforeEach(() => { h = ref.h; db = h.db; });

const VALID = "2026-11-05T12:00:00Z";
const POISON = "0000-01-01T00:00:00Z";

const toLegacy = async () => {
  await h.exec("DROP INDEX IF EXISTS flow_events_group_ms");
  await h.exec("ALTER TABLE flow_events DROP COLUMN IF EXISTS ts_ms");
  await h.exec("DROP FUNCTION IF EXISTS flow_ts_ms(TEXT)");
};

const putRaw = async (ts: string, receivedAt: number, sensorId = "s-1") => {
  await db.query(
    `INSERT INTO flow_events (flow_id, app_id, ts, src_ip, dst_ip, src_port, dst_port, protocol, bytes_in, bytes_out,
       packets, duration_ms, sensor_id, received_at) VALUES ($1,'app-1',$2,'64.0.113.5','64.0.113.9',1,2,'tcp',0,0,1,0,$3,$4)`,
    [randomUUID(), ts, sensorId, receivedAt],
  );
};

const rows = async () => (await db.query<{ ts: string; ts_ms: string | null; xmin: string }>(
  "SELECT ts, ts_ms, xmin::text AS xmin FROM flow_events ORDER BY ts, received_at")).rows
  .map((r) => ({ ts: r.ts, ts_ms: r.ts_ms === null ? null : Number(r.ts_ms), xmin: r.xmin }));

const heldAdvisory = async () => (await db.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM pg_locks
   WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND granted`, [FLOW_SCHEMA_LOCK])).rows[0]!.n;

const fresh = (id: string): FlowMetadataEvent => ({
  flow_id: id, app_id: "app-1", ts: VALID, src_ip: "203.0.113.8", dst_ip: "203.0.113.9",
  src_port: 1, dst_port: 2, protocol: "tcp", bytes_in: 0, bytes_out: 0, packets: 1, duration_ms: 0,
});

describe("R-B 常數", () => {
  it("lock_timeout 為 5s、回填批次 1000，CONCURRENTLY 的 statement_timeout 為 10min", () => {
    expect(FLOW_DDL_LOCK_TIMEOUT).toBe("5s");
    expect(FLOW_BACKFILL_BATCH).toBe(1000);
    expect(FLOW_INDEX_STATEMENT_TIMEOUT).toBe("10min");
  });
});

describe("回填完成且冪等；毒列不被重寫", () => {
  it("合法列回填＝Date.parse；第二次啟動不寫入，毒列 xmin 不變", async () => {
    await ensureFlowSchema(db);
    await toLegacy();
    await putRaw(VALID, 10);
    await putRaw(POISON, 20);
    await ensureFlowSchema(db);
    const first = await rows();
    expect(first).toEqual([
      { ts: POISON, ts_ms: null, xmin: first[0]!.xmin },
      { ts: VALID, ts_ms: Date.parse(VALID), xmin: first[1]!.xmin },
    ]);
    await ensureFlowSchema(db);
    expect(await rows()).toEqual(first);
  });
});

describe("DDL lock_timeout 逾時即失敗並釋放 advisory lock", () => {
  it("他連線持有 ACCESS EXCLUSIVE 時 ALTER 逾時拋錯，且 pg_locks 不再持有 schema lock", async () => {
    await ensureFlowSchema(db);
    await toLegacy();
    await h.withClient(async (c) => {
      await c.query("BEGIN");
      await c.query("LOCK TABLE flow_events IN ACCESS EXCLUSIVE MODE");
      await expect(ensureFlowSchema(db)).rejects.toMatchObject({ code: "55P03" });
      expect(await heldAdvisory()).toBe("0");
      await c.query("ROLLBACK");
    });
    expect(await heldAdvisory()).toBe("0");
  }, 15_000);

  it("回填掛勾拋錯時也會釋放 advisory lock", async () => {
    await ensureFlowSchema(db);
    await toLegacy();
    await putRaw(VALID, 10);
    await expect(ensureFlowSchema(db, {
      hooks: { afterBackfillBatchLock: async () => { throw new Error("hook-fail"); } },
    })).rejects.toThrow("hook-fail");
    expect(await heldAdvisory()).toBe("0");
  });
});

describe("回填進行中，ingest INSERT 與判定 SELECT 不被擋住", () => {
  it("一批回填持有列鎖時，另一連線的 INSERT 與判定 SELECT 在短逾時內完成", async () => {
    await ensureFlowSchema(db);
    await toLegacy();
    for (let i = 0; i < 30; i += 1) await putRaw(VALID, i + 1, `s-${i}`);
    let release: () => void = () => undefined;
    const proceed = new Promise<void>((ok) => { release = ok; });
    let signal: () => void = () => undefined;
    const locked = new Promise<void>((ok) => { signal = ok; });
    const backfill = ensureFlowSchema(db, {
      hooks: { afterBackfillBatchLock: async () => { signal(); await proceed; } },
    });
    const first = await Promise.race([locked.then(() => "locked" as const), backfill.then(() => "done" as const)]);
    expect(first).toBe("locked");
    await h.withClient(async (c) => {
      await c.query("SET statement_timeout = '1s'");
      const q = { query: async <T,>(sql: string, params?: unknown[]) => ({ rows: (await c.query(sql, params)).rows as T[] }) };
      await expect(insertFlow(q, fresh("new-1"), "s-new", 10_000)).resolves.toBe(true);
      const sel = await q.query(
        `SELECT sensor_id, app_id, src_ip, ts_ms, received_at FROM flow_events
         WHERE received_at > $1 AND received_at <= $2
         ORDER BY received_at, sensor_id, flow_id LIMIT 5000`, [9000, 11_000],
      );
      expect(sel.rows).toHaveLength(1);
    });
    release();
    await backfill;
    const filled = await db.query<{ n: string }>("SELECT count(*) FILTER (WHERE ts_ms IS NOT NULL)::text AS n FROM flow_events");
    expect(Number(filled.rows[0]!.n)).toBe(31);
  });
});
