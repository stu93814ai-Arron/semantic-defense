import { describe, expect, it } from "vitest";
import { parseAllowlistEntry, parseBlocklistSnapshot } from "../src/index.js";

type Obj = Record<string, unknown>;
type Case = [string, Obj, boolean];

const HEX64 = "a".repeat(64);
const SIG = "YWJjZGVmZ2hpams"; // base64url sample

const entry = (): Obj => ({
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

const snapBase = (): Obj => ({
  version: 1,
  generated_at: "2026-11-05T13:00:00.000Z",
  entries: [entry()],
  entries_sha256: HEX64,
  signature: SIG,
});

const snapOmit = (...keys: string[]): Obj =>
  Object.fromEntries(Object.entries(snapBase()).filter(([k]) => !keys.includes(k)));
const snapPatch = (p: Obj): Obj => ({ ...snapBase(), ...p });

const allowBase = (): Obj => ({
  entry_id: "770e8400-e29b-41d4-a716-446655440002",
  cidr: "203.0.113.0/24",
  reason: "office egress",
  created_by: "admin1",
  created_at: "2026-11-05T12:00:00.000Z",
  expires_at: null,
});

const allowOmit = (...keys: string[]): Obj =>
  Object.fromEntries(Object.entries(allowBase()).filter(([k]) => !keys.includes(k)));
const allowPatch = (p: Obj): Obj => ({ ...allowBase(), ...p });

describe("BlocklistSnapshotSchema", () => {
  it.each<Case>([
    ["合法空 entries", snapPatch({ entries: [] }), true],
    ["合法含一筆", snapBase(), true],
    ["sha 大寫 hex", snapPatch({ entries_sha256: "A".repeat(64) }), false],
    ["sha 混合大小寫", snapPatch({ entries_sha256: "Ab" + "c".repeat(62) }), false],
    ["signature 含 padding", snapPatch({ signature: `${SIG}==` }), false],
    ["signature 單 padding", snapPatch({ signature: `${SIG}=` }), false],
    ["version 0", snapPatch({ version: 0 }), false],
    ["version 負", snapPatch({ version: -1 }), false],
    ["version 非整", snapPatch({ version: 1.5 }), false],
    ["sha 長度 63", snapPatch({ entries_sha256: "a".repeat(63) }), false],
    ["sha 非 hex", snapPatch({ entries_sha256: "g".repeat(64) }), false],
    ["signature 含 +/", snapPatch({ signature: "abc+def/gh=" }), false],
    ["signature 空", snapPatch({ signature: "" }), false],
    ["缺 signature", snapOmit("signature"), false],
    ["缺 entries_sha256", snapOmit("entries_sha256"), false],
    ["缺 version", snapOmit("version"), false],
    ["多欄 note", snapPatch({ note: "x" }), false],
    ["entries 內非法", snapPatch({ entries: [{ ...entry(), ip: "127.0.0.1" }] }), false],
    ["壞 generated_at", snapPatch({ generated_at: "2026-11-05" }), false],
  ])("%s → ok=%s", (_n, input, ok) => {
    const r = parseBlocklistSnapshot(input);
    expect(r.ok).toBe(ok);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.errors)).not.toMatch(/127\.0\.0\.1|note/);
    }
  });
});

describe("AllowlistEntrySchema", () => {
  it.each<Case>([
    ["合法 /24", allowBase(), true],
    ["合法寬 /8", allowPatch({ cidr: "10.0.0.0/8" }), true],
    ["IPv4 /7 過寬", allowPatch({ cidr: "2.0.0.0/7" }), false],
    ["合法 IPv6 /32", allowPatch({ cidr: "2001:db8::/32" }), true],
    ["IPv6 /31 過寬", allowPatch({ cidr: "2000::/31" }), false],
    ["合法寬 /16", allowPatch({ cidr: "172.16.0.0/16" }), true],
    ["合法 IPv6 /48", allowPatch({ cidr: "2001:db8::/48" }), true],
    ["合法主機無前綴", allowPatch({ cidr: "198.51.100.7" }), true],
    ["expires 有值", allowPatch({ expires_at: "2026-12-01T00:00:00.000Z" }), true],
    ["expires ≤ created", allowPatch({ expires_at: "2026-11-05T11:00:00.000Z" }), false],
    ["expires = created", allowPatch({ expires_at: "2026-11-05T12:00:00.000Z" }), false],
    ["reason 上界 200", allowPatch({ reason: "r".repeat(200) }), true],
    ["/0", allowPatch({ cidr: "0.0.0.0/0" }), false],
    ["主機位非零", allowPatch({ cidr: "10.0.0.1/8" }), false],
    ["loopback", allowPatch({ cidr: "127.0.0.0/8" }), false],
    ["IPv4-mapped", allowPatch({ cidr: "::ffff:0:0/96" }), false],
    ["IPv6 大寫", allowPatch({ cidr: "2001:DB8::/48" }), false],
    ["zone %", allowPatch({ cidr: "fe80::1%eth0" }), false],
    ["reason 空", allowPatch({ reason: "" }), false],
    ["reason 201", allowPatch({ reason: "r".repeat(201) }), false],
    ["缺 expires_at", allowOmit("expires_at"), false],
    ["缺 cidr", allowOmit("cidr"), false],
    ["多欄 note", allowPatch({ note: "x" }), false],
    ["壞 uuid", allowPatch({ entry_id: "nope" }), false],
    ["created_by 空", allowPatch({ created_by: "" }), false],
  ])("%s → ok=%s", (_n, input, ok) => {
    const r = parseAllowlistEntry(input);
    expect(r.ok).toBe(ok);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.errors)).not.toMatch(/10\.0\.0\.1\/8|note/);
    }
  });
});
