import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listActive,
  listAllowlist,
  listPending,
  resetDemoStoreForTests,
  reviewAddAllowlist,
  reviewApprove,
  reviewReject,
  reviewWithdraw,
  seedFixturesForTests,
} from "./demoStore";

const CASE_A = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  seedFixturesForTests();
});

afterEach(() => {
  resetDemoStoreForTests();
});

describe("demoStore 整合決策", () => {
  it("核准後待審消失、上榜出現（鍵 case_id）", () => {
    const before = listPending().length;
    const r = reviewApprove(CASE_A, "operator1");
    expect(r.ok).toBe(true);
    expect(listPending()).toHaveLength(before - 1);
    expect(listActive("manual").some((e) => e.ip === "203.0.113.10")).toBe(true);
  });

  it("退回後不可再核准", () => {
    expect(reviewReject(CASE_A, "operator1", "範圍過寬").ok).toBe(true);
    const again = reviewApprove(CASE_A, "operator2");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("already_resolved");
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
    const r = reviewApprove(CASE_A, "operator1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("on_allowlist");
  });
});
