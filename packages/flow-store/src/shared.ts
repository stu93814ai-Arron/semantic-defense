/** 兩個入口共用（不對外匯出路徑；由 ./write 與 ./read 各自再匯出）。 */

/** 只需精簡 query 介面（sensor-auth 的 SensorDb、control-api 的 Db／tx client 皆相容）。 */
export type FlowDb = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/** flow_events／flow_rejections 保留期：年齡 ≥ 7 天即刪。 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
