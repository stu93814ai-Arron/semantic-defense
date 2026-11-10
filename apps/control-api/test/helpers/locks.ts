import pg from "pg";
import type { Queryable } from "../../src/db.js";
import { AUTO_LOCK } from "../../src/auto-breaker.js";
import { requireDatabaseUrl } from "./pg.js";

/**
 * 鎖等待測試護欄（資安 low）：等鎖的連線最多等 LOCK_TIMEOUT_MS，逾時以 55P03 失敗，不會卡住整個測試程序；
 * 這類測試另設 LOCK_TEST_TIMEOUT_MS（vitest timeout，> 2 × lock_timeout，小於全域 60s）。
 */
export const LOCK_TIMEOUT_MS = 5_000;
export const LOCK_TEST_TIMEOUT_MS = 15_000;

/** DATABASE_URL 加上 options=-c lock_timeout=…：用這個字串建的 app／連線，每條連線都帶護欄。 */
export function lockGuardedUrl(): string {
  const u = new URL(requireDatabaseUrl());
  u.searchParams.set("options", `-c lock_timeout=${LOCK_TIMEOUT_MS}`);
  return u.toString();
}

/** 第二條連線：開 tx 新增一筆白名單但先不 commit（持有 allowlist_entries 的 ROW EXCLUSIVE，會擋 SHARE）；commit() 才放。 */
export async function holdAllowlistInsert(cidr: string, createdAt: number): Promise<{ commit: () => Promise<void> }> {
  const c = new pg.Client({ connectionString: lockGuardedUrl() });
  await c.connect();
  await c.query("BEGIN");
  await c.query("INSERT INTO allowlist_entries VALUES (gen_random_uuid(), $1, 'office', 'admin1', $2, NULL)", [cidr, createdAt]);
  return { commit: async () => { await c.query("COMMIT"); await c.end(); } };
}

/** 輪詢 pg_locks：有 backend 在等 allowlist_entries 的 ShareLock → 回它的 pid；逾時回 null。 */
export async function waitShareWaiter(db: Queryable, timeoutMs = 3000, mode = "ShareLock"): Promise<number | null> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const r = await db.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE relation = 'allowlist_entries'::regclass AND mode = $1 AND NOT granted", [mode]);
    if (r.rows[0]) return r.rows[0].pid;
  }
  return null;
}

/** 這個 backend 是否已持有某把 xact advisory lock（key < 2^31：classid 0、objid = key、objsubid 1）。 */
export async function holdsAdvisory(db: Queryable, pid: number, key: number): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND objsubid = 1 AND pid = $2 AND granted",
    [key, pid]);
  return r.rows.length > 0;
}

/** 第二條連線：BEGIN 後先 SHARE 再拿 AUTO_LOCK（模擬判定 tick 持鎖），commit() 才放。 */
export async function holdShareAndAutoLock(): Promise<{ commit: () => Promise<void> }> {
  const c = new pg.Client({ connectionString: lockGuardedUrl() });
  await c.connect();
  await c.query("BEGIN");
  await c.query("LOCK TABLE allowlist_entries IN SHARE MODE");
  await c.query("SELECT pg_advisory_xact_lock($1)", [AUTO_LOCK]);
  return { commit: async () => { await c.query("COMMIT"); await c.end(); } };
}
