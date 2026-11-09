import { RETENTION_MS, type FlowDb } from "./shared.js";

/**
 * flow-store 唯讀入口（@semantic-defense/flow-store/read；給 control-api 判定 tick）。
 * 只放型別與查詢骨架，不含 DDL、不含寫入、不含判定邏輯；不得引入 write.ts（boundary.test 鎖住）。
 */
export { RETENTION_MS, type FlowDb };

/** flow_events 一列（pg 預設把 BIGINT 讀成字串）。sensor_id 取自 token、received_at＝ingest 時伺服器時間（epoch ms）。 */
export type FlowEventRow = {
  flow_id: string; app_id: string; ts: string; src_ip: string; dst_ip: string;
  src_port: number; dst_port: number; protocol: string;
  bytes_in: string; bytes_out: string; packets: string; duration_ms: string;
  sensor_id: string; received_at: string;
};

/** 防呆：flow_events 尚未由 sensor-ingest 建立時回 false（判定 tick 據此 no-op），不在管理面建表。 */
export async function flowEventsReady(db: FlowDb): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>("SELECT to_regclass('flow_events') IS NOT NULL AS ok");
  return r.rows[0]?.ok === true;
}
