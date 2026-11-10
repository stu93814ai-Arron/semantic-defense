import pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { FlowDb, FlowSession } from "../src/shared.js";
import { runWithPoolSession } from "../src/write.js";

export type SchemaDb = {
  db: FlowDb; exec(sql: string): Promise<unknown>; close(): Promise<void>;
  withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
};

/** 每個測試檔用自己的 schema（開啟時清空重建），避免與其他測試共用 Postgres 時互相清表。 */
export async function openSchemaDb(schema: string): Promise<SchemaDb> {
  const url = process.env.DATABASE_URL ?? "";
  if (url === "") throw new Error("DATABASE_URL 未設定：請以 `node scripts/with-pg.mjs …` 執行");
  const boot = new pg.Client({ connectionString: url });
  await boot.connect();
  try {
    await boot.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  } finally {
    await boot.end();
  }
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const withClient = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try { return await fn(c); } finally { c.release(); }
  };
  return {
    db: {
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
      withSession: <T>(fn: (q: FlowSession) => Promise<T>) => runWithPoolSession(pool, fn),
    },
    exec: (sql: string) => pool.query(sql),
    close: () => pool.end(),
    withClient,
  };
}

/**
 * 測試檔共用掛鉤：beforeAll 開 schema、afterAll 關、beforeEach 依序執行 resetSql。
 * 回傳的 ref.h 在 beforeAll 之後可用（測試檔自己的 beforeEach 在這之後才跑）。
 */
export function useSchemaDb(schema: string, resetSql: readonly string[]): { h: SchemaDb } {
  const ref = {} as { h: SchemaDb };
  beforeAll(async () => { ref.h = await openSchemaDb(schema); });
  afterAll(async () => { await ref.h?.close(); });
  beforeEach(async () => { for (const sql of resetSql) await ref.h.exec(sql); });
  return ref;
}
