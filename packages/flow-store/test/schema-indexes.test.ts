import { beforeEach, describe, expect, it } from "vitest";
import { ensureFlowSchema, type FlowDb } from "../src/write.js";
import { useSchemaDb, type SchemaDb } from "./helpers.js";

const RESET = ["DROP TABLE IF EXISTS flow_events", "DROP TABLE IF EXISTS flow_rejections", "DROP FUNCTION IF EXISTS flow_ts_ms(TEXT)"];
const ref = useSchemaDb("flow_store_schema_idx", RESET);
let h: SchemaDb;
let db: FlowDb;
beforeEach(() => { h = ref.h; db = h.db; });

describe("索引順序：先建新、再刪舊", () => {
  it("CREATE flow_events_group_ms 在 DROP flow_events_group 之前", async () => {
    const sqls: string[] = [];
    const wrap: FlowDb = {
      query: (sql, params) => db.query(sql, params),
      withSession: (fn) => db.withSession(async (q) => fn({
        query: async (sql, params) => {
          sqls.push(sql);
          return q.query(sql, params);
        },
      })),
    };
    await ensureFlowSchema(wrap);
    const createAt = sqls.findIndex((s) => /CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_events_group_ms/.test(s));
    const dropAt = sqls.findIndex((s) => /DROP INDEX CONCURRENTLY IF EXISTS flow_events_group\b/.test(s));
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeLessThan(dropAt);
  });
});

describe("CONCURRENTLY 結束後 RESET statement_timeout", () => {
  it("同一 session 上 SHOW statement_timeout 回到進入 ensureFlowSchema 前的值", async () => {
    const shown: string[] = [];
    const wrap: FlowDb = {
      query: (sql, params) => db.query(sql, params),
      withSession: (fn) => db.withSession(async (q) => {
        const before = (await q.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]!.statement_timeout;
        const out = await fn(q);
        const after = (await q.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]!.statement_timeout;
        shown.push(before, after);
        return out;
      }),
    };
    await ensureFlowSchema(wrap);
    expect(shown).toHaveLength(2);
    expect(shown[1]).toBe(shown[0]);
  });
});
