import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FLOW_INDEX_STATEMENT_TIMEOUT, FLOW_SCHEMA_LOCK, FLOW_SCHEMA_LOCK_WAIT_MS,
  ensureFlowSchema, type FlowDb,
} from "../src/write.js";
import { useSchemaDb, type SchemaDb } from "./helpers.js";

const RESET = ["DROP TABLE IF EXISTS flow_events", "DROP TABLE IF EXISTS flow_rejections", "DROP FUNCTION IF EXISTS flow_ts_ms(TEXT)"];
const ref = useSchemaDb("flow_store_schema_env", RESET);
let h: SchemaDb;
let db: FlowDb;
let savedWait: string | undefined;
let savedIndex: string | undefined;
beforeAll(() => {
  savedWait = process.env.SD_FLOW_SCHEMA_LOCK_WAIT_MS;
  savedIndex = process.env.SD_FLOW_INDEX_TIMEOUT_MS;
});
beforeEach(() => { h = ref.h; db = h.db; });
afterEach(() => {
  if (savedWait === undefined) delete process.env.SD_FLOW_SCHEMA_LOCK_WAIT_MS;
  else process.env.SD_FLOW_SCHEMA_LOCK_WAIT_MS = savedWait;
  if (savedIndex === undefined) delete process.env.SD_FLOW_INDEX_TIMEOUT_MS;
  else process.env.SD_FLOW_INDEX_TIMEOUT_MS = savedIndex;
});

describe("啟動環境變數預設值", () => {
  it("try_lock 輪詢上限預設 30 分鐘，CONCURRENTLY statement_timeout 預設 10min", () => {
    expect(FLOW_SCHEMA_LOCK_WAIT_MS).toBe(30 * 60_000);
    expect(FLOW_INDEX_STATEMENT_TIMEOUT).toBe("10min");
  });
});

describe("無效的逾時環境變數在啟動時拋錯", () => {
  it("SD_FLOW_INDEX_TIMEOUT_MS 非正整數時 ensureFlowSchema 拋錯", async () => {
    process.env.SD_FLOW_INDEX_TIMEOUT_MS = "nope";
    await expect(ensureFlowSchema(db)).rejects.toThrow(/SD_FLOW_INDEX_TIMEOUT_MS/);
  });

  it("SD_FLOW_SCHEMA_LOCK_WAIT_MS 非正整數時 ensureFlowSchema 拋錯", async () => {
    process.env.SD_FLOW_SCHEMA_LOCK_WAIT_MS = "-1";
    await expect(ensureFlowSchema(db)).rejects.toThrow(/SD_FLOW_SCHEMA_LOCK_WAIT_MS/);
  });
});

describe("try_lock 輪詢總逾時", () => {
  it("他連線持有 schema lock 時，超過 SD_FLOW_SCHEMA_LOCK_WAIT_MS 即拋錯且本連線不持有鎖", async () => {
    process.env.SD_FLOW_SCHEMA_LOCK_WAIT_MS = "200";
    await h.withClient(async (c) => {
      await c.query("SELECT pg_advisory_lock($1)", [FLOW_SCHEMA_LOCK]);
      try {
        await expect(ensureFlowSchema(db)).rejects.toThrow(/schema lock wait/);
        const n = (await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks
           WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND granted`, [FLOW_SCHEMA_LOCK])).rows[0]!.n;
        expect(n).toBe("1");
      } finally {
        await c.query("SELECT pg_advisory_unlock($1)", [FLOW_SCHEMA_LOCK]);
      }
    });
    const left = (await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks
       WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND granted`, [FLOW_SCHEMA_LOCK])).rows[0]!.n;
    expect(left).toBe("0");
  }, 8_000);
});
