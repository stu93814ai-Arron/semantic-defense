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
  it("先 SET 7s，結束後 SHOW 等於 pg_settings.reset_val（不是留下的 10min）", async () => {
    // RESET 還原的是 session 起始預設值（reset_val），不是呼叫前剛 SET 的 7s。
    // 先 SET 7s 是為了讓連線進入 ensureFlowSchema 前不是殘留的 10min，否則 before===after 什麼都證明不了。
    const shown: { after: string; resetVal: string } = { after: "", resetVal: "" };
    const wrap: FlowDb = {
      query: (sql, params) => db.query(sql, params),
      withSession: (fn) => db.withSession(async (q) => {
        await q.query("SET statement_timeout = '7s'");
        const mid = (await q.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]!.statement_timeout;
        expect(mid).toBe("7s");
        shown.resetVal = (await q.query<{ reset_val: string }>(
          "SELECT reset_val FROM pg_settings WHERE name = 'statement_timeout'")).rows[0]!.reset_val;
        const out = await fn(q);
        shown.after = (await q.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]!.statement_timeout;
        return out;
      }),
    };
    await ensureFlowSchema(wrap);
    expect(shown.after).toBe(shown.resetVal);
  });
});
