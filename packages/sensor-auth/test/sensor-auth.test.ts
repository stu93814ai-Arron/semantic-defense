import { describe, expect, it } from "vitest";
import { findSensorByToken, ipAllowed, parseSensorToken, sha256Hex, type SensorDb } from "../src/index.js";

const ID = "aaaaaaaa-2222-4333-8444-55555555beef";
const SECRET = "A".repeat(43);
const TOKEN = `sdst_${ID}.${SECRET}`;

function fakeDb(row?: { token_hash: string; revoked_at: string | null; allowed_cidrs: string[]; allowed_app_ids?: string[] }) {
  const calls: unknown[][] = [];
  const db: SensorDb = {
    query: async <T>(_sql: string, params?: unknown[]) => {
      calls.push(params ?? []);
      return { rows: (row ? [row] : []) as T[] };
    },
  };
  return { db, calls };
}

describe("sensor-auth", () => {
  it("parseSensorToken：只接受 sdst_<uuid>.<43 字 base64url>", () => {
    expect(parseSensorToken(TOKEN)).toEqual({ sensorId: ID, secret: SECRET });
    for (const t of ["", `sdst_${ID}`, `sdst_${ID}.short`, `xx_${ID}.${SECRET}`, `sdst_${ID.toUpperCase()}.${SECRET}`]) {
      expect(parseSensorToken(t)).toBeNull();
    }
  });

  it("findSensorByToken：依 sensor_id 單列查找；錯 secret／已撤銷／查無 → null", async () => {
    const ok = fakeDb({ token_hash: sha256Hex(SECRET), revoked_at: null, allowed_cidrs: ["10.0.0.0/8"], allowed_app_ids: ["app-1"] });
    expect(await findSensorByToken(ok.db, TOKEN)).toEqual({ sensor_id: ID, allowed_cidrs: ["10.0.0.0/8"], allowed_app_ids: ["app-1"] });
    expect(ok.calls).toEqual([[ID]]);
    expect(await findSensorByToken(ok.db, `sdst_${ID}.${"B".repeat(43)}`)).toBeNull();
    const rev = fakeDb({ token_hash: sha256Hex(SECRET), revoked_at: "1", allowed_cidrs: ["10.0.0.0/8"] });
    expect(await findSensorByToken(rev.db, TOKEN)).toBeNull();
    expect(await findSensorByToken(fakeDb().db, TOKEN)).toBeNull();
    const bad = fakeDb();
    expect(await findSensorByToken(bad.db, "nope")).toBeNull();
    expect(bad.calls).toEqual([]);
  });

  it("ipAllowed：IPv4／IPv6 CIDR 包含判斷，IPv4-mapped 視同 IPv4", () => {
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("192.168.1.1", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("garbage", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("10.1.2.3", ["bad/cidr"])).toBe(false);
  });
});
