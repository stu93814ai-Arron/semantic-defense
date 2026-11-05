import { describe, expect, it } from "vitest";
import { parseBlocklistEntry } from "../src/index.js";

type Obj = Record<string, unknown>;
type Case = [string, Obj, boolean];

const base = (): Obj => ({
  entry_id: "550e8400-e29b-41d4-a716-446655440000",
  ip: "203.0.113.10",
  source: "manual",
  confidence: 0.9,
  case_id: "660e8400-e29b-41d4-a716-446655440001",
  created_at: "2026-11-05T12:00:00.000Z",
  expires_at: "2026-11-06T12:00:00.000Z",
  approved_by: "admin1",
  approved_at: "2026-11-05T12:30:00.000Z",
  revoked_at: null,
});

const omit = (...keys: string[]): Obj =>
  Object.fromEntries(Object.entries(base()).filter(([k]) => !keys.includes(k)));
const patch = (p: Obj): Obj => ({ ...base(), ...p });

describe("BlocklistEntrySchema", () => {
  it.each<Case>([
    ["合法 IPv4 主機", base(), true],
    ["合法 IPv4 /24", patch({ ip: "203.0.113.0/24" }), true],
    ["合法私有 10/24", patch({ ip: "10.0.0.0/24" }), true],
    ["合法私有 192.168/32", patch({ ip: "192.168.1.1" }), true],
    ["合法 IPv6 /64", patch({ ip: "2001:db8::/64" }), true],
    ["合法 IPv6 主機", patch({ ip: "2001:db8::1" }), true],
    ["auto /32", patch({ source: "auto", ip: "198.51.100.7", approved_by: "system:auto" }), true],
    ["revoked_at 有值", patch({ revoked_at: "2026-11-05T18:00:00.000Z" }), true],
    ["IPv4 前綴 /23", patch({ ip: "203.0.112.0/23" }), false],
    ["IPv6 前綴 /63", patch({ ip: "2001:db8::/63" }), false],
    ["/0", patch({ ip: "0.0.0.0/0" }), false],
    ["主機位非零 /24", patch({ ip: "203.0.113.10/24" }), false],
    ["loopback", patch({ ip: "127.0.0.1" }), false],
    ["未指定", patch({ ip: "0.0.0.0" }), false],
    ["multicast", patch({ ip: "224.0.0.1" }), false],
    ["broadcast", patch({ ip: "255.255.255.255" }), false],
    ["link-local", patch({ ip: "169.254.1.1" }), false],
    ["IPv6 loopback", patch({ ip: "::1" }), false],
    ["IPv6 link-local", patch({ ip: "fe80::1" }), false],
    ["IPv6 zone %", patch({ ip: "fe80::1%eth0" }), false],
    ["auto 非 /32", patch({ source: "auto", ip: "203.0.113.0/24", approved_by: "system:auto" }), false],
    ["expires ≤ created", patch({ expires_at: "2026-11-05T11:00:00.000Z" }), false],
    ["approved 早於 created", patch({ approved_at: "2026-11-05T11:00:00.000Z" }), false],
    ["approved 晚於 expires", patch({ approved_at: "2026-11-07T12:00:00.000Z" }), false],
    ["revoked 早於 created", patch({ revoked_at: "2026-11-05T11:00:00.000Z" }), false],
    ["缺 revoked_at", omit("revoked_at"), false],
    ["缺 ip", omit("ip"), false],
    ["多欄 note", patch({ note: "x" }), false],
    ["confidence >1", patch({ confidence: 1.1 }), false],
    ["confidence NaN", patch({ confidence: Number.NaN }), false],
    ["approved_by 空", patch({ approved_by: "" }), false],
  ])("%s → ok=%s", (_n, input, ok) => {
    const r = parseBlocklistEntry(input);
    expect(r.ok).toBe(ok);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.errors)).not.toMatch(/203\.0\.113\.10\/24|note/);
    }
  });
});
