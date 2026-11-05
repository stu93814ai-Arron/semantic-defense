import { afterEach, describe, expect, it } from "vitest";
import {
  listActive,
  listAllowlist,
  listPending,
  resetDemoStoreForTests,
  reviewAddAllowlist,
  reviewApprove,
  reviewReject,
  reviewWithdraw,
} from "./demoStore";

afterEach(() => {
  resetDemoStoreForTests();
});

describe("demoStore 整合決策", () => {
  it("核准後待審消失、上榜出現", () => {
    const before = listPending().length;
    const r = reviewApprove("cand-1", "operator1");
    expect(r.ok).toBe(true);
    expect(listPending()).toHaveLength(before - 1);
    expect(listActive("manual").some((e) => e.ip === "203.0.113.10")).toBe(true);
  });

  it("退回後不可再核准", () => {
    expect(reviewReject("cand-1", "operator1").ok).toBe(true);
    const again = reviewApprove("cand-1", "operator2");
    expect(again.ok).toBe(false);
  });

  it("撤回後不在 active 清單", () => {
    expect(reviewWithdraw("list-auto-1", "operator1").ok).toBe(true);
    expect(listActive("all")).toHaveLength(0);
  });

  it("白名單新增後擋黑名單核准", () => {
    expect(
      reviewAddAllowlist(
        { cidr: "203.0.113.10", reason: "夥伴" },
        "admin1",
      ).ok,
    ).toBe(true);
    expect(listAllowlist()).toHaveLength(1);
    const r = reviewApprove("cand-1", "operator1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("on_allowlist");
  });
});
