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
  CHECK (0.30 <= case_threshold AND case_threshold < auto_threshold AND 0.70 <= auto_threshold AND auto_threshold <= 1)
)`,
  `CREATE TABLE IF NOT EXISTS allowlist_entries (
  entry_id UUID PRIMARY KEY,
  cidr TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NULL CHECK (expires_at IS NULL OR expires_at > created_at)
)`,
  `CREATE TABLE IF NOT EXISTS blocklist_entries (
  entry_id UUID PRIMARY KEY,
  ip TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','auto')),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  case_id UUID NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL CHECK (expires_at > created_at),
  approved_by TEXT NOT NULL,
  approved_at BIGINT NOT NULL CHECK (approved_at >= created_at AND approved_at <= expires_at),
  revoked_at BIGINT NULL CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  ended_at BIGINT NULL CHECK (ended_at IS NULL OR ended_at >= created_at)
)`,
  // ended_at：只放 DB、不進契約（過期 sweep 設 expires_at；撤回設撤回時間）。同 IP 至多一筆 ended_at IS NULL。
  // 註：IF NOT EXISTS 不會幫舊表加 ended_at 欄；本階段不做 migration。
  "CREATE UNIQUE INDEX IF NOT EXISTS blocklist_one_active ON blocklist_entries (ip) WHERE ended_at IS NULL",
  // 成案流程 commit 10（計畫 §5）：E3.A 冷卻查「同 IP 最近撤回」。
  "CREATE INDEX IF NOT EXISTS blocklist_ip_revoked ON blocklist_entries (ip, revoked_at)",
  // 成案流程 commit 11（計畫 §5／§6.3）：熔斷數滑動 1 小時的 auto 筆數；auto_breaker 單列只記開關（判斷轉換寫稽核）。
  "CREATE INDEX IF NOT EXISTS blocklist_auto_created ON blocklist_entries (created_at) WHERE source = 'auto'",
  "CREATE TABLE IF NOT EXISTS auto_breaker (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), opened_at BIGINT NULL)",
  "INSERT INTO auto_breaker (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING",
  // 成案流程 commit 6（計畫 §5）：待審與命中明細。註：IF NOT EXISTS 不會改舊表；本階段不做 migration。
  `CREATE TABLE IF NOT EXISTS blacklist_cases (
  case_id UUID PRIMARY KEY,
  ip TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','approved','rejected','expired','auto_listed')),
  max_confidence DOUBLE PRECISION NOT NULL CHECK (max_confidence >= 0 AND max_confidence <= 1),
  hit_count INTEGER NOT NULL CHECK (hit_count >= 1),
  has_late BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL CHECK (expires_at = created_at + 86400000),
  last_hit_at BIGINT NOT NULL CHECK (last_hit_at >= created_at),
  resolved_by TEXT NULL,
  resolved_at BIGINT NULL,
  CHECK ((state = 'open') = (resolved_at IS NULL))
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS blacklist_cases_one_open ON blacklist_cases (ip) WHERE state = 'open'",
  `CREATE TABLE IF NOT EXISTS case_hits (
  src_ip TEXT NOT NULL,
  sensor_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  ontime_confidence DOUBLE PRECISION NULL,
  first_seen_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (src_ip, sensor_id, app_id, window_start)
)`,
  "CREATE INDEX IF NOT EXISTS case_hits_ip_window ON case_hits (src_ip, window_start)",
  // 判定 tick 進度（計畫 §2／§5）：單列，received_upto＝已掃到的 flow_events.received_at（epoch ms）。
  "CREATE TABLE IF NOT EXISTS judge_cursor (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), received_upto BIGINT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  sensor_id TEXT NULL,
  at BIGINT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
)`,
  // 資安退回 R5：hit_while_listed 每個 entry_id 每小時最多一筆，寫前查過去 1 小時（judge.ts auditedWithinHour）用的 partial index。
  `CREATE INDEX IF NOT EXISTS audit_hit_while_listed_entry ON audit_events (action, (detail->>'entry_id'), at)
   WHERE action = 'blacklist.hit_while_listed'`,
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
    tx: <T>(fn: (q: Queryable) => Promise<T>) => runTx(pool, fn),
  };
}

/** runTx 只需要的 pool／client 介面（測試可注入假物件）。 */
export type TxClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(err?: Error | boolean): void;
};
export type TxPool = { connect(): Promise<TxClient> };

/**
 * Db.tx 實作：同一 client 上 BEGIN → fn → COMMIT；fn 拋錯則 ROLLBACK 後原樣拋出。
 * ROLLBACK 也失敗時以 release(err) 丟棄該連線，避免把卡在中斷交易的連線還回 pool；其餘情況 release()。
 */
export async function runTx<T>(pool: TxPool, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard: Error | undefined;
  try {
    await client.query("BEGIN");
    const q: Queryable = {
      query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as R[] }),
    };
    const out = await fn(q);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      discard = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    if (discard) client.release(discard);
    else client.release();
  }
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
