import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import { RETENTION_MS, type FlowDb, type FlowSession } from "./shared.js";

export { RETENTION_MS, type FlowDb, type FlowSession };

/**
 * flow-store 寫入入口（@semantic-defense/flow-store/write；只給 sensor-ingest）。自 sensor-ingest store.ts 搬出，行為不變。
 * flow_events／flow_rejections 的 DDL 只在這裡（boundary.test 鎖住）；control-api 只能用唯讀入口 ./read。
 * ③c 存入＋保留期：表 flow_events。
 * - 契約欄位全部＋接收層中繼欄位 sensor_id（取自 token，不採自報）、received_at（ingest 時 now，epoch ms）。
 * - PK (sensor_id, flow_id)：flow_id 只在單一 sensor 內唯一。
 * - 不對 sensor_tokens 設 FK：token 撤銷不影響舊列，sensor_id 永久保留。
 * - 保留 7 天：年齡 ≥ RETENTION_MS（now - received_at／at >= 7d）即刪（含 flow_rejections）。
 */

/** 遷移串行化：多實例同時啟動時，建表／補欄／回填一次只跑一個（session 級 pg_advisory_lock，finally 釋放）。 */
export const FLOW_SCHEMA_LOCK = 872_364_210;
/** DDL 短交易等鎖上限；逾時即失敗並 throw，避免啟動掛死。 */
export const FLOW_DDL_LOCK_TIMEOUT = "5s";
/** 回填每批列數；每批獨立短交易，只拿列鎖。 */
export const FLOW_BACKFILL_BATCH = 1000;
/** CREATE／DROP INDEX CONCURRENTLY 不能用 lock_timeout，改用 statement_timeout；逾時即失敗並 throw。 */
export const FLOW_INDEX_STATEMENT_TIMEOUT = "10min";
/** CONCURRENTLY statement_timeout 預設毫秒（可用 SD_FLOW_INDEX_TIMEOUT_MS 覆寫）。 */
export const FLOW_INDEX_TIMEOUT_MS = 10 * 60_000;
/** try_lock 輪詢總等待上限預設（可用 SD_FLOW_SCHEMA_LOCK_WAIT_MS 覆寫）。 */
export const FLOW_SCHEMA_LOCK_WAIT_MS = 30 * 60_000;
/** 等待 schema lock 時，每隔這段時間 warn 一次（只記已等待毫秒）。 */
export const FLOW_SCHEMA_LOCK_WARN_EVERY_MS = 30_000;

/** 讀取正整數環境變數；未設或空白用 fallback。無效值（非正整數）立即拋錯。 */
function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`invalid ${name}`);
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid ${name}`);
  return n;
}

export const flowSchemaLockWaitMs = (): number =>
  parsePositiveInt("SD_FLOW_SCHEMA_LOCK_WAIT_MS", process.env.SD_FLOW_SCHEMA_LOCK_WAIT_MS, FLOW_SCHEMA_LOCK_WAIT_MS);
/** Postgres statement_timeout 為 32-bit 毫秒，超過此值拒絕（含 2147483648）。 */
export const FLOW_INDEX_TIMEOUT_MAX_MS = 2_147_483_647;

export const flowIndexTimeoutMs = (): number => {
  const n = parsePositiveInt("SD_FLOW_INDEX_TIMEOUT_MS", process.env.SD_FLOW_INDEX_TIMEOUT_MS, FLOW_INDEX_TIMEOUT_MS);
  if (n > FLOW_INDEX_TIMEOUT_MAX_MS) throw new Error("invalid SD_FLOW_INDEX_TIMEOUT_MS");
  return n;
};

/** 測試掛勾：不可從產品啟動路徑傳入。 */
export type FlowSchemaHooks = {
  /** 一批回填已 UPDATE（持有列鎖、尚未 COMMIT）。測試用來並行 INSERT／判定 SELECT。 */
  afterBackfillBatchLock?: () => Promise<void>;
};

/**
 * 在 pool 的同一條連線上執行 fn（給 ingest／測試把 session lock、CONCURRENTLY、回填綁在一起）。
 * 不引入 pg 型別，只要有 connect／query／release。
 */
export async function runWithPoolSession<T>(
  pool: { connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>; release(): void }> },
  fn: (q: FlowSession) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn({
      query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as R[] }),
    });
  } finally {
    client.release();
  }
}

const onSession = <T>(db: FlowDb, fn: (q: FlowSession) => Promise<T>): Promise<T> =>
  db.withSession(fn);

const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS flow_events (
  flow_id TEXT NOT NULL, app_id TEXT NOT NULL, ts TEXT NOT NULL,
  src_ip TEXT NOT NULL, dst_ip TEXT NOT NULL, src_port INTEGER NOT NULL, dst_port INTEGER NOT NULL,
  protocol TEXT NOT NULL, bytes_in BIGINT NOT NULL, bytes_out BIGINT NOT NULL,
  packets BIGINT NOT NULL, duration_ms BIGINT NOT NULL,
  sensor_id TEXT NOT NULL, received_at BIGINT NOT NULL, ts_ms BIGINT NULL,
  PRIMARY KEY (sensor_id, flow_id)
)`;

const TS_MS_FN = `CREATE OR REPLACE FUNCTION flow_ts_ms(t TEXT) RETURNS BIGINT LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN floor(extract(epoch FROM t::timestamptz) * 1000)::bigint;
EXCEPTION WHEN data_exception OR feature_not_supported THEN
  RETURN NULL;
END
$fn$`;

const REJECTIONS_DDL = `CREATE TABLE IF NOT EXISTS flow_rejections (id BIGSERIAL PRIMARY KEY, sensor_id TEXT NOT NULL, at BIGINT NOT NULL, reason TEXT NOT NULL)`;

async function columnExists(q: FlowSession, table: string, column: string): Promise<boolean> {
  const r = await q.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.rows.length > 0;
}

async function indexInvalid(q: FlowSession, name: string): Promise<boolean> {
  const r = await q.query<{ invalid: boolean }>(
    `SELECT NOT i.indisvalid AS invalid
     FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND n.nspname = current_schema()`,
    [name],
  );
  return r.rows[0]?.invalid === true;
}


async function inShortTx<T>(q: FlowSession, fn: () => Promise<T>): Promise<T> {
  await q.query("BEGIN");
  try {
    const out = await fn();
    await q.query("COMMIT");
    return out;
  } catch (err) {
    try { await q.query("ROLLBACK"); } catch { /* 仍拋原錯 */ }
    throw err;
  }
}

async function runDdl(q: FlowSession): Promise<void> {
  await inShortTx(q, async () => {
    await q.query("SET LOCAL lock_timeout = '5s'");
    await q.query(EVENTS_DDL);
    if (!(await columnExists(q, "flow_events", "ts_ms"))) {
      await q.query("ALTER TABLE flow_events ADD COLUMN ts_ms BIGINT NULL");
    }
    await q.query(TS_MS_FN);
    await q.query(REJECTIONS_DDL);
    if (!(await columnExists(q, "flow_rejections", "reason"))) {
      await q.query("ALTER TABLE flow_rejections ADD COLUMN reason TEXT NOT NULL DEFAULT 'unbound_app'");
    }
    await q.query("CREATE INDEX IF NOT EXISTS flow_events_received_at ON flow_events (received_at)");
    await q.query("CREATE INDEX IF NOT EXISTS flow_rejections_at ON flow_rejections (at)");
  });
}

async function ensureGroupIndexes(q: FlowSession): Promise<void> {
  await q.query(`SET statement_timeout = ${flowIndexTimeoutMs()}`);
  try {
    if (await indexInvalid(q, "flow_events_group_ms")) {
      await q.query("DROP INDEX CONCURRENTLY IF EXISTS flow_events_group_ms");
    }
    await q.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_events_group_ms ON flow_events (sensor_id, app_id, src_ip, ts_ms)");
    await q.query("DROP INDEX CONCURRENTLY IF EXISTS flow_events_group");
    if (await indexInvalid(q, "flow_rejections_sensor_at")) {
      await q.query("DROP INDEX CONCURRENTLY IF EXISTS flow_rejections_sensor_at");
    }
    await q.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_rejections_sensor_at ON flow_rejections (sensor_id, at)");
  } finally {
    await q.query("RESET statement_timeout");
  }
}

type BatchCursor = { received_at: number; sensor_id: string; flow_id: string };

type BatchRow = { sensor_id: string; flow_id: string; received_at: string };

async function loadBackfillRows(q: FlowSession, cursor: BatchCursor | null): Promise<BatchRow[]> {
  return (await q.query<BatchRow>(
    `SELECT sensor_id, flow_id, received_at FROM flow_events
     WHERE ts_ms IS NULL AND ($1::bigint IS NULL OR (received_at, sensor_id, flow_id) > ($1, $2, $3))
     ORDER BY received_at, sensor_id, flow_id
     LIMIT ${FLOW_BACKFILL_BATCH}
     FOR UPDATE`,
    [cursor?.received_at ?? null, cursor?.sensor_id ?? "", cursor?.flow_id ?? ""],
  )).rows;
}

async function fillConvertible(q: FlowSession, rows: BatchRow[]): Promise<void> {
  await q.query(
    `UPDATE flow_events AS e SET ts_ms = flow_ts_ms(e.ts)
     FROM unnest($1::text[], $2::text[]) AS v(sensor_id, flow_id)
     WHERE e.sensor_id = v.sensor_id AND e.flow_id = v.flow_id
       AND flow_ts_ms(e.ts) IS NOT NULL`,
    [rows.map((r) => r.sensor_id), rows.map((r) => r.flow_id)],
  );
}

async function backfillBatch(q: FlowSession, cursor: BatchCursor | null, hooks?: FlowSchemaHooks): Promise<BatchCursor | "done"> {
  return inShortTx(q, async () => {
    const rows = await loadBackfillRows(q, cursor);
    const last = rows.at(-1);
    if (!last) return "done";
    await fillConvertible(q, rows);
    await hooks?.afterBackfillBatchLock?.();
    return { received_at: Number(last.received_at), sensor_id: last.sensor_id, flow_id: last.flow_id };
  });
}

async function backfillTsMs(q: FlowSession, hooks?: FlowSchemaHooks): Promise<void> {
  let cursor: BatchCursor | null = null;
  for (;;) {
    const next = await backfillBatch(q, cursor, hooks);
    if (next === "done") return;
    cursor = next;
  }
}

/**
 * sensor-ingest 啟動時呼叫（control-api 不建表、不建索引）；可重複、可並行。
 * 回填在本函式內跑完才返回，因此 sensor-ingest 的 listen 會等到回填結束（阻擋本實例啟動）。
 * 理由：聽埠前欄位、函式、索引與回填都已一致，不必另開背景連線或處理背景失敗；
 * 其他已在跑的 ingest INSERT 與判定 SELECT 只碰到列鎖，可繼續工作。
 */

/** 用 try_lock 輪詢，避免他實例堵在 pg_advisory_lock 的開著的 statement 上，與 CONCURRENTLY 互相等待。
 * 總等待上限為 SD_FLOW_SCHEMA_LOCK_WAIT_MS（預設 30 分鐘），逾時即 throw；持有者連線斷開時
 * Postgres 仍會自動釋放 session 級 advisory lock。等待期間每 30 秒 warn 一次，物件只含 waited_ms。
 */
async function acquireSchemaLock(q: FlowSession, log?: { warn(obj: object, msg: string): void }): Promise<void> {
  const limit = flowSchemaLockWaitMs();
  const started = Date.now();
  let warnedAt = started;
  for (;;) {
    const r = await q.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [FLOW_SCHEMA_LOCK]);
    if (r.rows[0]?.ok === true) return;
    const waited = Date.now() - started;
    if (waited >= limit) throw new Error("flow schema lock wait timed out");
    if (Date.now() - warnedAt >= FLOW_SCHEMA_LOCK_WARN_EVERY_MS) {
      log?.warn({ waited_ms: waited }, "flow schema lock wait");
      warnedAt = Date.now();
    }
    await new Promise<void>((ok) => { setTimeout(ok, 50); });
  }
}

export async function ensureFlowSchema(db: FlowDb, opts?: { hooks?: FlowSchemaHooks; log?: { warn(obj: object, msg: string): void } }): Promise<void> {
  flowSchemaLockWaitMs();
  flowIndexTimeoutMs();
  await onSession(db, async (q) => {
    await acquireSchemaLock(q, opts?.log);
    try {
      await runDdl(q);
      await ensureGroupIndexes(q);
      await backfillTsMs(q, opts?.hooks);
    } finally {
      await q.query("SELECT pg_advisory_unlock($1)", [FLOW_SCHEMA_LOCK]);
    }
  });
}

/** 刪除年齡 ≥ 7 天的 flow_events／flow_rejections，回兩表刪除總筆數。 */
export async function purgeExpired(db: FlowSession, now: number): Promise<number> {
  const cutoff = now - RETENTION_MS;
  const ev = await db.query<{ flow_id: string }>(
    "DELETE FROM flow_events WHERE received_at <= $1 RETURNING flow_id", [cutoff],
  );
  const rej = await db.query<{ sensor_id: string }>(
    "DELETE FROM flow_rejections WHERE at <= $1 RETURNING sensor_id", [cutoff],
  );
  return ev.rows.length + rej.rows.length;
}

/** ts 的 epoch ms（Q1：JS Date.parse，與 SQL flow_ts_ms 同值）；解析不出數字 → NULL。 */
const tsMsOf = (ts: string): number | null => {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
};

/** 寫入一筆（含 ts_ms）；同 sensor 重複 flow_id → false（不同 sensor 可重用 flow_id）。 */
export async function insertFlow(db: FlowSession, f: FlowMetadataEvent, sensorId: string, now: number): Promise<boolean> {
  const r = await db.query<{ flow_id: string }>(
    `INSERT INTO flow_events (flow_id, app_id, ts, src_ip, dst_ip, src_port, dst_port, protocol,
       bytes_in, bytes_out, packets, duration_ms, sensor_id, received_at, ts_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (sensor_id, flow_id) DO NOTHING RETURNING flow_id`,
    [f.flow_id, f.app_id, f.ts, f.src_ip, f.dst_ip, f.src_port, f.dst_port, f.protocol,
      f.bytes_in, f.bytes_out, f.packets, f.duration_ms, sensorId, now, tsMsOf(f.ts)],
  );
  return r.rows.length === 1;
}

/** 拒絕原因常數（A 組領航員裁示；總召 §21:09 R10）。不得放入位址。 */
export const REJECTION_UNBOUND_APP = "unbound_app";
export const REJECTION_RESERVED = "reserved";
export const REJECTION_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
const REJECTION_REASONS = new Set([REJECTION_UNBOUND_APP, REJECTION_RESERVED]);

/** 記一筆拒絕（每請求一列）；reason 僅允許常數，不收 payload。 */
export async function recordRejection(db: FlowSession, sensorId: string, now: number, reason: string): Promise<void> {
  if (!REJECTION_REASONS.has(reason)) throw new Error("invalid rejection reason");
  await db.query("INSERT INTO flow_rejections (sensor_id, at, reason) VALUES ($1,$2,$3)", [sensorId, now, reason]);
}

/** 指定 sensor 的指定 reason 在 [now − 24h, now] 的筆數（health 用；不跨 sensor）。 */
export async function countRejections(db: FlowSession, now: number, reason: string, sensorId: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM flow_rejections WHERE sensor_id = $1 AND reason = $2 AND at >= $3",
    [sensorId, reason, now - REJECTION_COUNT_WINDOW_MS],
  );
  return Number(r.rows[0]!.n);
}
