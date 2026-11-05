import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

/**
 * 感測器 token 認證共用層（control-api 發放端與 sensor-ingest 驗證端共用）。
 * - 格式 `sdst_<sensor_id>.<secret>`；secret 為 256 bit 隨機 base64url（43 字）。
 * - 查找 O(1)：先以 sensor_id 取單列，再以 SHA-256＋timingSafeEqual 比對（secret 高熵，無需 KDF）。
 * - 不依賴 control-api／console；只需精簡 query 介面。
 */
export type SensorDb = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type SensorIdentity = { sensor_id: string; allowed_cidrs: string[]; allowed_app_ids: string[] };

const TOKEN_RE = /^sdst_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
export const sha256Hex = (s: string): string => sha256(s).toString("hex");

export function parseSensorToken(token: string): { sensorId: string; secret: string } | null {
  const m = TOKEN_RE.exec(token);
  return m ? { sensorId: m[1]!, secret: m[2]! } : null;
}

/** 有效 token → { sensor_id, allowed_cidrs }；否則 null（含已撤銷）。 */
export async function findSensorByToken(db: SensorDb, token: string): Promise<SensorIdentity | null> {
  const p = parseSensorToken(token);
  if (!p) return null;
  const r = await db.query<{ token_hash: string; revoked_at: string | null; allowed_cidrs: string[]; allowed_app_ids: string[] }>(
    "SELECT token_hash, revoked_at, allowed_cidrs, allowed_app_ids FROM sensor_tokens WHERE sensor_id = $1", [p.sensorId],
  );
  const row = r.rows[0];
  const given = sha256(p.secret);
  const stored = row ? Buffer.from(row.token_hash, "hex") : Buffer.alloc(32);
  const ok = stored.length === 32 && timingSafeEqual(given, stored);
  if (!row || !ok || row.revoked_at !== null) return null;
  return { sensor_id: p.sensorId, allowed_cidrs: row.allowed_cidrs, allowed_app_ids: row.allowed_app_ids };
}

const MAPPED_RE = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

function addCidr(bl: BlockList, cidr: string): void {
  const [net, pfx] = cidr.split("/");
  const v = isIP(net ?? "");
  if (v === 0) return;
  const bits = pfx === undefined ? (v === 4 ? 32 : 128) : Number(pfx);
  try { bl.addSubnet(net!, bits, v === 4 ? "ipv4" : "ipv6"); } catch { /* 略過無效 CIDR */ }
}

/** 來源 IP 是否落在任一 allowed_cidrs 內；IPv4-mapped IPv6 視同 IPv4。格式錯誤一律 false。 */
export function ipAllowed(ip: string, cidrs: readonly string[]): boolean {
  const addr = MAPPED_RE.exec(ip)?.[1] ?? ip;
  const fam = isIP(addr);
  if (fam === 0) return false;
  const bl = new BlockList();
  for (const c of cidrs) addCidr(bl, c);
  return bl.check(addr, fam === 4 ? "ipv4" : "ipv6");
}
