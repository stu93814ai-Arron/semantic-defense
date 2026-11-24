import pg from "pg";
import { describe, expect, it } from "vitest";
import { ensureFlowSchema } from "../src/write.js";
import { useSchemaDb } from "./helpers.js";

/**
 * ci 步驟 1 卡住（cl2）：CREATE INDEX CONCURRENTLY 會等「同一資料庫」內所有持有較舊快照的交易。
 * control-api 測試直接連 DATABASE_URL 開交易；flow-store 測試若也在同一資料庫，ensureFlowSchema 就會排在它們後面。
 * 這裡用 DATABASE_URL 上一條 REPEATABLE READ 交易（已取快照、不結束）模擬 control-api 測試，確定性重現，不靠時序。
 */
const BOUND_MS = 5_000;
const RESET = ["DROP TABLE IF EXISTS flow_events", "DROP TABLE IF EXISTS flow_rejections", "DROP FUNCTION IF EXISTS flow_ts_ms(TEXT)"];
const ref = useSchemaDb("sd_flow_store_db_isolation", RESET);

const within = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<"timeout">((ok) => { t = setTimeout(() => ok("timeout"), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
};

describe("flow-store 測試資料庫與 control-api 測試隔離", () => {
  it("DATABASE_URL 上有開著的交易（模擬 control-api 測試）時，ensureFlowSchema 仍於時限內完成", async () => {
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    let run: Promise<void> | undefined;
    try {
      await other.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await other.query("SELECT 1");
      run = ensureFlowSchema(ref.h.db);
      expect(await within(run, BOUND_MS)).not.toBe("timeout");
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      await run?.catch(() => {});
      await other.end();
    }
  }, 30_000);
});
