import pg from "pg";
import type { Queryable } from "../../src/db.js";
import { requireDatabaseUrl } from "./pg.js";

/** 第二條連線：開 tx 新增一筆白名單但先不 commit（持有 allowlist_entries 的 ROW EXCLUSIVE，會擋 SHARE）；commit() 才放。 */
export async function holdAllowlistInsert(cidr: string, createdAt: number): Promise<{ commit: () => Promise<void> }> {
  const c = new pg.Client({ connectionString: requireDatabaseUrl() });
  await c.connect();
  await c.query("BEGIN");
  await c.query("INSERT INTO allowlist_entries VALUES (gen_random_uuid(), $1, 'office', 'admin1', $2, NULL)", [cidr, createdAt]);
  return { commit: async () => { await c.query("COMMIT"); await c.end(); } };
}

/** 輪詢 pg_locks：有 backend 在等 allowlist_entries 的 ShareLock → 回它的 pid；逾時回 null。 */
export async function waitShareWaiter(db: Queryable, timeoutMs = 3000): Promise<number | null> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const r = await db.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE relation = 'allowlist_entries'::regclass AND mode = 'ShareLock' AND NOT granted");
    if (r.rows[0]) return r.rows[0].pid;
  }
  return null;
}
