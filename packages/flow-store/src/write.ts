import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import { RETENTION_MS, type FlowDb } from "./shared.js";

export { RETENTION_MS, type FlowDb };

/**
 * flow-store 寫入入口（@semantic-defense/flow-store/write；只給 sensor-ingest）。自 sensor-ingest store.ts 搬出，行為不變。
 * flow_events／flow_rejections 的 DDL 只在這裡（boundary.test 鎖住）；control-api 只能用唯讀入口 ./read。
 * ③c 存入＋保留期：表 flow_events。
 * - 契約欄位全部＋接收層中繼欄位 sensor_id（取自 token，不採自報）、received_at（ingest 時 now，epoch ms）。
 * - PK (sensor_id, flow_id)：flow_id 只在單一 sensor 內唯一。
 * - 不對 sensor_tokens 設 FK：token 撤銷不影響舊列，sensor_id 永久保留。
 * - 保留 7 天：年齡 ≥ RETENTION_MS（now - received_at／at >= 7d）即刪（含 flow_rejections）。
 */

/** 遷移串行化：sensor-ingest 多實例同時啟動時，建表／補欄／回填一次只跑一個（pg_advisory_xact_lock，交易結束自動釋放）。 */
export const FLOW_SCHEMA_LOCK = 872_364_210;

/**
 * 一個多語句 simple query＝一個隱含交易（不寫 BEGIN／COMMIT：中途出錯整串回滾，不會把 pool 連線留在 aborted 交易）。
 * ts_ms（ts slice，計畫 Q1–Q8）：ts 的 epoch ms，由 insertFlow 以 JS Date.parse 寫入；判定 tick 只讀 ts_ms、不再對 ts 做 ::timestamptz。
 * - flow_ts_ms：SQL 端同值換算（floor 到 ms），只吞 data_exception（class 22：0000 年、offset ±23:59…）回 NULL，其他錯誤照拋；
 *   ::timestamptz 依 TimeZone 設定，故 STABLE 不標 IMMUTABLE。
 * - 回填：每次啟動都跑 WHERE ts_ms IS NULL（舊列、滾動升級期間舊版 ingest 寫的列；Q2／Q4）。這是 flow_events 全表掃描，
 *   且整段持有 FLOW_SCHEMA_LOCK——見 docs R15 部署前檢查。
 * - flow_events_group_ms：判定 tick 依 (sensor, app, src_ip) 等值＋ts_ms 範圍重讀整組；完整索引（非 partial，Q7）。
 */
const SCHEMA_SQL = `
SELECT pg_advisory_xact_lock(${FLOW_SCHEMA_LOCK});
CREATE TABLE IF NOT EXISTS flow_events (
  flow_id TEXT NOT NULL, app_id TEXT NOT NULL, ts TEXT NOT NULL,
  src_ip TEXT NOT NULL, dst_ip TEXT NOT NULL, src_port INTEGER NOT NULL, dst_port INTEGER NOT NULL,
  protocol TEXT NOT NULL, bytes_in BIGINT NOT NULL, bytes_out BIGINT NOT NULL,
  packets BIGINT NOT NULL, duration_ms BIGINT NOT NULL,
  sensor_id TEXT NOT NULL, received_at BIGINT NOT NULL, ts_ms BIGINT NULL,
  PRIMARY KEY (sensor_id, flow_id)
);
ALTER TABLE flow_events ADD COLUMN IF NOT EXISTS ts_ms BIGINT NULL;
CREATE OR REPLACE FUNCTION flow_ts_ms(t TEXT) RETURNS BIGINT LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN floor(extract(epoch FROM t::timestamptz) * 1000)::bigint;
EXCEPTION WHEN data_exception THEN
  RETURN NULL;
END
$fn$;
UPDATE flow_events SET ts_ms = flow_ts_ms(ts) WHERE ts_ms IS NULL;
CREATE INDEX IF NOT EXISTS flow_events_received_at ON flow_events (received_at);
-- 舊索引（依 ts 文字）：commit 4 依 Q3 grep 結果決定是否移除
CREATE INDEX IF NOT EXISTS flow_events_group ON flow_events (sensor_id, app_id, src_ip, ts);
CREATE INDEX IF NOT EXISTS flow_events_group_ms ON flow_events (sensor_id, app_id, src_ip, ts_ms);
-- app_id 未綁定的拒絕紀錄：只記 id（代理 PK）＋sensor_id＋時間，不記 payload；與 flow_events 同 7 天清除。
-- 註：IF NOT EXISTS 不會改既有舊表（無 id）的結構。
CREATE TABLE IF NOT EXISTS flow_rejections (id BIGSERIAL PRIMARY KEY, sensor_id TEXT NOT NULL, at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS flow_rejections_at ON flow_rejections (at);
`;

/** sensor-ingest 啟動時呼叫（control-api 不建表、不建索引）；可重複、可並行。 */
export async function ensureFlowSchema(db: FlowDb): Promise<void> {
  await db.query(SCHEMA_SQL);
}

/** 刪除年齡 ≥ 7 天的 flow_events／flow_rejections，回兩表刪除總筆數。 */
export async function purgeExpired(db: FlowDb, now: number): Promise<number> {
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
export async function insertFlow(db: FlowDb, f: FlowMetadataEvent, sensorId: string, now: number): Promise<boolean> {
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

/** 記一筆 app_id 未綁定的拒絕；刻意不收 payload。 */
export async function recordRejection(db: FlowDb, sensorId: string, now: number): Promise<void> {
  await db.query("INSERT INTO flow_rejections (sensor_id, at) VALUES ($1,$2)", [sensorId, now]);
}
