/** 兩個入口共用（不對外匯出路徑；由 ./write 與 ./read 各自再匯出）。 */

/** 單一連線上的查詢（session advisory lock、CONCURRENTLY、分批回填都走同一條）。 */
export type FlowSession = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/**
 * 只需精簡 query 介面（sensor-auth 的 SensorDb、control-api 的 Db／tx client 皆相容）。
 * withSession：在同一條後端連線上執行；pool 必須提供，否則假設 query 已綁定單一 client。
 */
export type FlowDb = FlowSession & {
  withSession?: <T>(fn: (q: FlowSession) => Promise<T>) => Promise<T>;
};

/** flow_events／flow_rejections 保留期：年齡 ≥ 7 天即刪。 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
