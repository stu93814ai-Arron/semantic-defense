import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

/** c1：Db.tx — 同一 client 上 BEGIN／COMMIT／ROLLBACK，最後 release。 */
let db: Db;
beforeAll(async () => { db = await openDb(requireDatabaseUrl()); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec("TRUNCATE TABLE audit_events RESTART IDENTITY"); });

const insert = (q: Pick<Db, "query">, action: string) =>
  q.query("INSERT INTO audit_events (action, actor, sensor_id, at) VALUES ($1,'t',NULL,1)", [action]);
const actions = async () => (await db.query<{ action: string }>("SELECT action FROM audit_events ORDER BY id")).rows.map((r) => r.action);

describe("Db.tx", () => {
  it("成功 → COMMIT：交易內寫入可見，回傳 fn 的值", async () => {
    const r = await db.tx(async (q) => { await insert(q, "a"); await insert(q, "b"); return 42; });
    expect(r).toBe(42);
    expect(await actions()).toEqual(["a", "b"]);
  });

  it("中途 throw → ROLLBACK：先前寫入全部撤銷，錯誤原樣拋出", async () => {
    const boom = new Error("boom");
    await expect(db.tx(async (q) => { await insert(q, "a"); throw boom; })).rejects.toBe(boom);
    expect(await actions()).toEqual([]);
  });

  it("SQL 錯誤 → ROLLBACK；之後連線仍可用（client 已 release）", async () => {
    await expect(db.tx(async (q) => { await insert(q, "a"); await q.query("SELECT * FROM no_such_table"); })).rejects.toThrow();
    expect(await actions()).toEqual([]);
    for (let i = 0; i < 15; i++) await db.tx(async (q) => insert(q, `ok${i}`));
    expect(await actions()).toHaveLength(15);
  });

  it("交易未提交前，其他連線看不到寫入", async () => {
    let seen: string[] = ["x"];
    await db.tx(async (q) => { await insert(q, "hidden"); seen = await actions(); });
    expect(seen).toEqual([]);
    expect(await actions()).toEqual(["hidden"]);
  });
});
