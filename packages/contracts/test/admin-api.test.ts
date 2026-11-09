import { describe, expect, it } from "vitest";
import {
  ADMIN_API_PATHS, AllowlistCreateSchema, AllowlistListSchema, AllowlistUpdateSchema, BlocklistListSchema,
  DEFAULT_THRESHOLDS, PendingCandidateListSchema, PendingCandidateSchema, ThresholdsSchema,
} from "../src/admin-api.js";
import * as main from "../src/index.js";

const ok = (schema: { safeParse(x: unknown): { success: boolean } }, x: unknown) => schema.safeParse(x).success;
const T = "2026-11-09T00:00:00Z";
const CASE = "11111111-1111-4111-8111-111111111111";

describe("管理面 HTTP 契約：路徑常數", () => {
  it("黑名單待審／上榜／撤回、白名單 CRUD、門檻：固定路徑，皆在 /api 下", () => {
    expect(ADMIN_API_PATHS).toEqual({
      thresholds: "/api/thresholds",
      blacklist: "/api/blacklist",
      blacklistRevoke: "/api/blacklist/:entryId/revoke",
      blacklistPending: "/api/blacklist/pending",
      whitelist: "/api/whitelist",
      whitelistEntry: "/api/whitelist/:entryId",
    });
    expect(Object.isFrozen(ADMIN_API_PATHS)).toBe(true);
  });

  it("主入口轉出同一個實作", () => {
    expect(main.ADMIN_API_PATHS).toBe(ADMIN_API_PATHS);
    expect(main.ThresholdsSchema).toBe(ThresholdsSchema);
    expect(main.PendingCandidateSchema).toBe(PendingCandidateSchema);
  });
});

describe("門檻 {case, auto}", () => {
  it("預設 case 0.50、auto 0.90，與 flow-verdict 常數一致", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ case: 0.5, auto: 0.9 });
    expect(DEFAULT_THRESHOLDS).toEqual({ case: main.CASE_THRESHOLD, auto: main.AUTO_THRESHOLD });
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
  });

  it.each([
    { case: 0.5, auto: 0.9 }, { case: 0, auto: 0 }, { case: 1, auto: 1 }, { case: 0.7, auto: 0.7 }, { case: 0, auto: 1 },
  ])("接受 %j", (x) => { expect(ok(ThresholdsSchema, x)).toBe(true); });

  it.each([
    [{ case: 0.95, auto: 0.9 }, "case>auto"], [{ case: -0.01, auto: 0.9 }, "<0"], [{ case: 0.5, auto: 1.01 }, ">1"],
    [{ case: Number.NaN, auto: 0.9 }, "NaN"], [{ case: 0.5, auto: Number.POSITIVE_INFINITY }, "Infinity"],
    [{ case: "0.5", auto: 0.9 }, "字串"], [{ case: 0.5 }, "缺 auto"], [{ auto: 0.9 }, "缺 case"],
    [{ case: 0.5, auto: 0.9, x: 1 }, "多餘欄位"], [null, "null"], [[0.5, 0.9], "陣列"],
  ] as [unknown, string][])("拒絕 %j（%s）", (x) => { expect(ok(ThresholdsSchema, x)).toBe(false); });
});

describe("黑名單待審候選（以 case_id 為鍵）", () => {
  const P = { ip: "203.0.113.10", confidence: 0.6, case_id: CASE, created_at: T };
  it("只有 ip、confidence、case_id、created_at", () => {
    expect(ok(PendingCandidateSchema, P)).toBe(true);
    expect(ok(PendingCandidateSchema, { ...P, ip: "2001:db8::1" })).toBe(true);
    expect(ok(PendingCandidateSchema, { ...P, ip: "203.0.113.10/32" })).toBe(true);
    expect(ok(PendingCandidateSchema, { ...P, candidate_id: "cand-1" })).toBe(false);
    for (const k of Object.keys(P)) {
      const rest = Object.fromEntries(Object.entries(P).filter(([key]) => key !== k));
      expect(ok(PendingCandidateSchema, rest), k).toBe(false);
    }
  });
  it.each(["203.0.113.0/24", "2001:db8::/64", "127.0.0.1", "::ffff:203.0.113.10", "2001:DB8::1", "fe80::1%eth0"])(
    "ip 只收 /32、/128（ip-cidr 規則）：拒 %s", (ip) => { expect(ok(PendingCandidateSchema, { ...P, ip })).toBe(false); });
  it.each([-0.1, 1.1, Number.NaN])("confidence 0..1 有限值：拒 %s", (confidence) => {
    expect(ok(PendingCandidateSchema, { ...P, confidence })).toBe(false);
  });
  it("case_id 須 uuid、created_at 須 RFC3339；列表為 {items}", () => {
    expect(ok(PendingCandidateSchema, { ...P, case_id: "x" })).toBe(false);
    expect(ok(PendingCandidateSchema, { ...P, created_at: "yesterday" })).toBe(false);
    expect(ok(PendingCandidateListSchema, { items: [P] })).toBe(true);
    expect(ok(PendingCandidateListSchema, { items: [P], total: 1 })).toBe(false);
  });
});

describe("黑名單已上榜列表與白名單 CRUD 本文", () => {
  const ENTRY = {
    entry_id: "22222222-2222-4222-8222-222222222222", ip: "198.51.100.1", source: "auto", confidence: 0.96, case_id: CASE,
    created_at: T, expires_at: "2026-11-10T00:00:00Z", approved_by: "system:auto", approved_at: T, revoked_at: null,
  };
  it("黑名單列表 {items: 黑名單項目[]}，沿用 BlocklistEntry 規則（多欄位整份拒絕）", () => {
    expect(ok(BlocklistListSchema, { items: [ENTRY] })).toBe(true);
    expect(ok(BlocklistListSchema, { items: [{ ...ENTRY, extra: 1 }] })).toBe(false);
    expect(ok(BlocklistListSchema, { items: [{ ...ENTRY, ip: "198.51.100.0/24" }] })).toBe(false);
  });

  it("白名單新增：只收 cidr、reason、expires_at（伺服端填 entry_id／created_by／created_at）", () => {
    const C = { cidr: "10.0.0.0/8", reason: "辦公室", expires_at: null };
    expect(ok(AllowlistCreateSchema, C)).toBe(true);
    expect(ok(AllowlistCreateSchema, { ...C, expires_at: T })).toBe(true);
    expect(ok(AllowlistCreateSchema, { ...C, entry_id: ENTRY.entry_id })).toBe(false);
    expect(ok(AllowlistCreateSchema, { ...C, created_by: "admin1" })).toBe(false);
    expect(ok(AllowlistCreateSchema, { cidr: C.cidr, reason: C.reason })).toBe(false);
    for (const cidr of ["10.0.0.0/7", "10.0.0.1/8", "127.0.0.0/8", "::ffff:a00:0/104", "2001:DB8::/32"]) {
      expect(ok(AllowlistCreateSchema, { ...C, cidr }), cidr).toBe(false);
    }
    expect(ok(AllowlistCreateSchema, { ...C, reason: "" })).toBe(false);
    expect(ok(AllowlistCreateSchema, { ...C, reason: "x".repeat(201) })).toBe(false);
  });

  it("白名單修改：只收 reason、expires_at（cidr 不可改；兩者皆必填）", () => {
    expect(ok(AllowlistUpdateSchema, { reason: "r", expires_at: null })).toBe(true);
    expect(ok(AllowlistUpdateSchema, { reason: "r", expires_at: null, cidr: "10.0.0.0/8" })).toBe(false);
    expect(ok(AllowlistUpdateSchema, { reason: "r" })).toBe(false);
  });

  it("白名單列表 {items: 白名單項目[]}", () => {
    const A = { entry_id: ENTRY.entry_id, cidr: "10.0.0.0/8", reason: "r", created_by: "admin1", created_at: T, expires_at: null };
    expect(ok(AllowlistListSchema, { items: [A] })).toBe(true);
    expect(ok(AllowlistListSchema, { items: [{ ...A, x: 1 }] })).toBe(false);
  });
});
