/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- 程序入口：鍵為常值、TLS 路徑來自部署環境變數（運維設定，非請求輸入） */
import { readFileSync } from "node:fs";
import pg from "pg";
import { buildIngest } from "./app.js";

/** 流量平面程序入口：DATABASE_URL、SENSOR_INGEST_TLS_KEY／_CERT（PEM 路徑，必填）、SENSOR_INGEST_HOST／_PORT。 */
const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} 未設定：sensor-ingest 拒絕無設定啟動`);
  return v;
};

const pool = new pg.Pool({ connectionString: env("DATABASE_URL") });
const db = { query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }) };
const app = await buildIngest({
  db,
  https: { key: readFileSync(env("SENSOR_INGEST_TLS_KEY")), cert: readFileSync(env("SENSOR_INGEST_TLS_CERT")) },
});
await app.listen({ host: process.env.SENSOR_INGEST_HOST ?? "0.0.0.0", port: Number(process.env.SENSOR_INGEST_PORT ?? 8443) });
