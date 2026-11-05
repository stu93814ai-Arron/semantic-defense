import { PGlite } from "@electric-sql/pglite";

/** 可換驅動的精簡查詢介面。生產應以 openPg(DATABASE_URL) 接真 Postgres；此處 PGlite 僅測試／嵌入式適配。 */
export type Db = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
};

/** 第 2 階段資料表：使用者、應用擁有權、伺服器端 session。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator','app_owner','platform_admin'))
);
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_seen BIGINT NOT NULL
);`;

function asDb(pg: PGlite): Db {
  return {
    query: <T>(sql: string, params?: unknown[]) =>
      pg.query<T>(sql, params as never) as Promise<{ rows: T[] }>,
    exec: (sql: string) => pg.exec(sql),
    close: () => pg.close(),
  };
}

/** 測試／本機嵌入式：PGlite。生產請改走同介面的 Postgres 適配器。 */
export async function openDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(SCHEMA);
  return asDb(pg);
}
