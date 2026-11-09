import { describe, expect, it } from "vitest";
import { addAllowlist, removeAllowlist, updateAllowlist, validateAllowlistCidr } from "./allowlistForm";
import type { AllowlistItem } from "./types";

describe("白名單新增／刪除與格式（contracts assertAllowlistCidr）", () => {
  it("接受合法 IPv4／CIDR（前綴 ≥ /8）與 canonical IPv6 ≥/32", () => {
    expect(validateAllowlistCidr("203.0.113.5").ok).toBe(true);
    expect(validateAllowlistCidr("203.0.113.0/24").ok).toBe(true);
    expect(validateAllowlistCidr("10.0.0.0/8").ok).toBe(true);
    expect(validateAllowlistCidr("2001:db8::/32").ok).toBe(true);
  });

  it("格式錯誤擋下（過寬、主機位非零、空）", () => {
    expect(validateAllowlistCidr("").ok).toBe(false);
    expect(validateAllowlistCidr("10.0.0.0/7").ok).toBe(false);
    expect(validateAllowlistCidr("203.0.113.1/24").ok).toBe(false);
    expect(validateAllowlistCidr("not-an-ip").ok).toBe(false);
  });

  it("拒 IPv6 過寬、非 canonical、主機位非零", () => {
    expect(validateAllowlistCidr("2001:db8::/31").ok).toBe(false);
    expect(validateAllowlistCidr("2001:0db8::/32").ok).toBe(false);
    expect(validateAllowlistCidr("2001:db8::1/32").ok).toBe(false);
  });

  it("拒保留位址（loopback／未指定／multicast／link-local）", () => {
    expect(validateAllowlistCidr("127.0.0.1").ok).toBe(false);
    expect(validateAllowlistCidr("0.0.0.0").ok).toBe(false);
    expect(validateAllowlistCidr("224.0.0.1").ok).toBe(false);
    expect(validateAllowlistCidr("169.254.1.1").ok).toBe(false);
    expect(validateAllowlistCidr("::1").ok).toBe(false);
    expect(validateAllowlistCidr("fe80::1").ok).toBe(false);
  });

  it("新增寫稽核；reason 1–200 字", () => {
    const r = addAllowlist(
      { cidr: "203.0.113.0/24", reason: "夥伴網段" },
      { actorId: "admin1", now: "2026-11-05T03:00:00Z" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cidr).toBe("203.0.113.0/24");
    expect(r.audit.action).toBe("whitelist.add");
  });

  it("reason 空白或過長失敗", () => {
    const empty = addAllowlist(
      { cidr: "203.0.113.0/24", reason: "" },
      { actorId: "admin1", now: "2026-11-05T03:00:00Z" },
    );
    expect(empty.ok).toBe(false);
    const long = addAllowlist(
      { cidr: "203.0.113.0/24", reason: "x".repeat(201) },
      { actorId: "admin1", now: "2026-11-05T03:00:00Z" },
    );
    expect(long.ok).toBe(false);
  });

  it("刪除寫稽核", () => {
    const item: AllowlistItem = {
      entry_id: "w1",
      cidr: "203.0.113.0/24",
      reason: "夥伴",
      created_by: "admin1",
      created_at: "2026-11-05T00:00:00Z",
      expires_at: null,
    };
    const r = removeAllowlist(item, {
      actorId: "admin1",
      now: "2026-11-05T04:00:00Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audit.action).toBe("whitelist.remove");
  });
});

describe("白名單 reason（AllowlistCreate／Update schema）", () => {
  it("拒控制字元、bidi、ZWJ、lone surrogate", () => {
    for (const bad of ["\n夥伴", "辦\u200d公室", "\ud800", "\u200e出口"]) {
      const r = addAllowlist(
        { cidr: "203.0.113.0/24", reason: bad },
        { actorId: "admin1", now: "2026-11-05T03:00:00Z" },
      );
      expect(r.ok, bad).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("invalid_reason");
        expect(r.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("updateAllowlist 以 AllowlistUpdateSchema 驗證 reason", () => {
    const item: AllowlistItem = {
      entry_id: "w1",
      cidr: "203.0.113.0/24",
      reason: "夥伴",
      created_by: "admin1",
      created_at: "2026-11-05T00:00:00Z",
      expires_at: null,
    };
    const ok = updateAllowlist(
      item,
      { reason: "更新理由", expires_at: null },
      { actorId: "admin1", now: "2026-11-05T05:00:00Z" },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.reason).toBe("更新理由");
    expect(ok.audit.action).toBe("whitelist.update");

    const bad = updateAllowlist(
      item,
      { reason: "x\u0000y", expires_at: null },
      { actorId: "admin1", now: "2026-11-05T05:00:00Z" },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid_reason");
  });
});
