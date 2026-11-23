import pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { FlowDb, FlowSession } from "../src/shared.js";
import { runWithPoolSession } from "../src/write.js";

export type SchemaDb = {
  db: FlowDb; exec(sql: string): Promise<unknown>; close(): Promise<void>;
  withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
};

const SQL_IDENT = /^[a-z_][a-z0-9_]*$/;

function requireIdent(name: string): string {
  if (!SQL_IDENT.test(name)) throw new Error("資料庫識別碼格式不符");
  return name;
}

/** 只改 URL 的資料庫名稱；呼叫端不得印出回傳值（含密碼）。 */
function urlWithDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * 每個測試檔用自己的 Postgres 資料庫（開啟時清空重建），庫內再建獨立 schema。
 * 與 control-api／sensor-ingest 測試所用的 DATABASE_URL 資料庫隔離，避免
 * CREATE INDEX CONCURRENTLY 等待同一資料庫內其他交易的較舊快照。
 */
export async function openSchemaDb(schema: string): Promise<SchemaDb> {
  const url = process.env.DATABASE_URL ?? "";
  if (url === "") throw new Error("DATABASE_URL 未設定：請以 `node scripts/with-pg.mjs …` 執行");
  const ident = requireIdent(schema);
  const boot = new pg.Client({ connectionString: url });
  await boot.connect();
  try {
    await boot.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [ident],
    );
    await boot.query(`DROP DATABASE IF EXISTS ${ident}`);
    await boot.query(`CREATE DATABASE ${ident}`);
  } finally {
    await boot.end();
  }
  const isolated = urlWithDatabase(url, ident);
  const setup = new pg.Client({ connectionString: isolated });
  await setup.connect();
  try {
    await setup.query(`CREATE SCHEMA ${ident}`);
  } finally {
    await setup.end();
  }
  const pool = new pg.Pool({ connectionString: isolated, options: `-c search_path=${ident}` });
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
