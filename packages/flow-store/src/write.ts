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

const DDL = [
  `CREATE TABLE IF NOT EXISTS flow_events (
  flow_id TEXT NOT NULL, app_id TEXT NOT NULL, ts TEXT NOT NULL,
  src_ip TEXT NOT NULL, dst_ip TEXT NOT NULL, src_port INTEGER NOT NULL, dst_port INTEGER NOT NULL,
  protocol TEXT NOT NULL, bytes_in BIGINT NOT NULL, bytes_out BIGINT NOT NULL,
  packets BIGINT NOT NULL, duration_ms BIGINT NOT NULL,
  sensor_id TEXT NOT NULL, received_at BIGINT NOT NULL,
  PRIMARY KEY (sensor_id, flow_id)
)`,
  "CREATE INDEX IF NOT EXISTS flow_events_received_at ON flow_events (received_at)",
  // app_id 未綁定的拒絕紀錄：只記 id（代理 PK）＋sensor_id＋時間，不記 payload；與 flow_events 同 7 天清除。
  // 註：IF NOT EXISTS 不會改既有舊表（無 id）的結構；本階段不做 migration。
  "CREATE TABLE IF NOT EXISTS flow_rejections (id BIGSERIAL PRIMARY KEY, sensor_id TEXT NOT NULL, at BIGINT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS flow_rejections_at ON flow_rejections (at)",
];

export async function ensureFlowSchema(db: FlowDb): Promise<void> {
  for (const sql of DDL) await db.query(sql);
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

/** 寫入一筆；同 sensor 重複 flow_id → false（不同 sensor 可重用 flow_id）。 */
export async function insertFlow(db: FlowDb, f: FlowMetadataEvent, sensorId: string, now: number): Promise<boolean> {
  const r = await db.query<{ flow_id: string }>(
    `INSERT INTO flow_events (flow_id, app_id, ts, src_ip, dst_ip, src_port, dst_port, protocol,
       bytes_in, bytes_out, packets, duration_ms, sensor_id, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (sensor_id, flow_id) DO NOTHING RETURNING flow_id`,
    [f.flow_id, f.app_id, f.ts, f.src_ip, f.dst_ip, f.src_port, f.dst_port, f.protocol,
      f.bytes_in, f.bytes_out, f.packets, f.duration_ms, sensorId, now],
  );
  return r.rows.length === 1;
}

/** 記一筆 app_id 未綁定的拒絕；刻意不收 payload。 */
export async function recordRejection(db: FlowDb, sensorId: string, now: number): Promise<void> {
  await db.query("INSERT INTO flow_rejections (sensor_id, at) VALUES ($1,$2)", [sensorId, now]);
}
