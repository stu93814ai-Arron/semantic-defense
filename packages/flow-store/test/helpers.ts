import pg from "pg";
import type { FlowDb } from "../src/shared.js";

/** 每個測試檔用自己的 schema（開啟時清空重建），避免與其他測試共用 Postgres 時互相清表。 */
export async function openSchemaDb(schema: string): Promise<{ db: FlowDb; exec(sql: string): Promise<unknown>; close(): Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 未設定：請以 `node scripts/with-pg.mjs …` 執行");
  const boot = new pg.Client({ connectionString: url });
  await boot.connect();
  await boot.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await boot.query(`CREATE SCHEMA ${schema}`);
  await boot.end();
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  return {
    db: { query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }) },
    exec: (sql: string) => pool.query(sql),
    close: () => pool.end(),
  };
}
