import pg from "pg";

/** 可換驅動的精簡查詢介面；生產與測試皆走 Postgres（via databaseUrl／DATABASE_URL）。 */
export type Db = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
  /** 交易：同一 client 上 BEGIN → fn → COMMIT；fn 拋錯則 ROLLBACK 後原樣拋出；最後一律 release。 */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
};

/** 只能查詢的介面（Db 本身或交易中的 client）；稽核等寫入函式吃這個，才能放進 tx。 */
export type Queryable = Pick<Db, "query">;

/** 第 2 階段 schema 語句（逐條執行，搭配 advisory lock 避免並行建表競態）。 */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator','app_owner','platform_admin'))
)`,
  `CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT ''
)`,
  `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_seen BIGINT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS login_failures (
  username TEXT NOT NULL,
  ip TEXT NOT NULL,
  failure_count INTEGER NOT NULL,
  window_started_at BIGINT NOT NULL,
  PRIMARY KEY (username, ip)
)`,
  `CREATE TABLE IF NOT EXISTS sensor_tokens (
  sensor_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  revoked_at BIGINT NULL,
  allowed_cidrs TEXT[] NOT NULL CHECK (cardinality(allowed_cidrs) >= 1),
  allowed_app_ids TEXT[] NOT NULL CHECK (cardinality(allowed_app_ids) >= 1)
)`,
  `CREATE TABLE IF NOT EXISTS thresholds (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  case_threshold DOUBLE PRECISION NOT NULL,
  auto_threshold DOUBLE PRECISION NOT NULL,
  CHECK (0 <= case_threshold AND case_threshold <= auto_threshold AND auto_threshold <= 1)
)`,
  `CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  sensor_id TEXT NULL,
  at BIGINT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
)`,
];

/** 固定鍵：跨連線序列化 schema 遷移。 */
const SCHEMA_LOCK = 872_364_201;

export function resolveDatabaseUrl(databaseUrl?: string): string {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL／databaseUrl 未設定：control-api 需要 Postgres，拒絕無連線啟動",
    );
  }
  return url;
}

function asDb(pool: pg.Pool): Db {
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[] };
    },
    exec: async (sql: string) => {
      await pool.query(sql);
    },
    close: async () => {
      await pool.end();
    },
    tx: async <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const q: Queryable = {
          query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as R[] }),
        };
        const out = await fn(q);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

async function migrate(client: pg.PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK]);
  try {
    for (const sql of SCHEMA_STATEMENTS) {
      await client.query(sql);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK]);
  }
}

/** 以連線字串開 Postgres、套用 schema。連線字串僅來自參數／環境，不寫死密鑰。 */
export async function openDb(databaseUrl: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }
  return asDb(pool);
}
