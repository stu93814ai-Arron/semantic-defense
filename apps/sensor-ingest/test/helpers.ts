/* eslint-disable security/detect-non-literal-fs-filename -- 測試：路徑來自暫存目錄與本套件 src 走訪，非外部輸入 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { sha256Hex, type SensorDb } from "@semantic-defense/sensor-auth";

/** 獨立 schema，避免與 control-api 測試共用 Postgres 時互相 TRUNCATE。DDL 與 control-api 的 sensor_tokens 欄位一致（無 FK）。 */
const SCHEMA = "sensor_ingest_test";

export async function openTestDb(): Promise<SensorDb & { close(): Promise<void>; reset(): Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 未設定：請以 `node scripts/with-pg.mjs …` 執行");
  const boot = new pg.Client({ connectionString: url });
  await boot.connect();
  await boot.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await boot.end();
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
  await pool.query(`CREATE TABLE IF NOT EXISTS sensor_tokens (
    sensor_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_by INTEGER NOT NULL,
    created_at BIGINT NOT NULL, revoked_at BIGINT NULL, allowed_cidrs TEXT[] NOT NULL)`);
  return {
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
    reset: async () => { await pool.query("TRUNCATE sensor_tokens"); await pool.query("DROP TABLE IF EXISTS flow_events"); },
    close: async () => { await pool.end(); },
  };
}

export async function seedToken(db: SensorDb, cidrs: string[], revoked = false): Promise<string> {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sensor_tokens (sensor_id, token_hash, created_by, created_at, allowed_cidrs, revoked_at) VALUES ($1,$2,1,0,$3,$4)",
    [id, sha256Hex(secret), cidrs, revoked ? 1 : null],
  );
  return `sdst_${id}.${secret}`;
}

/** 以 openssl 產生拋棄式自簽憑證（僅測試）。 */
export function selfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "si-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
