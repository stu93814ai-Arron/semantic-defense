import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  injectPendingForTests,
  isBackendUnreachable,
  listActive,
  listAllowlist,
  listPending,
  resetDemoStoreForTests,
  reviewAddAllowlist,
  reviewApprove,
  reviewReject,
  reviewWithdraw,
  seedFixturesForTests,
  setBackendUnreachable,
} from "./demoStore";

const CASE_A = "11111111-1111-4111-8111-111111111111";
const CASE_B = "55555555-5555-4555-8555-555555555555";

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

  it("白名單命中者不出現在待審清單", () => {
    expect(
      reviewAddAllowlist({ cidr: "203.0.113.10", reason: "夥伴" }, "admin1").ok,
    ).toBe(true);
    expect(listAllowlist()).toHaveLength(1);
    expect(listPending().some((p) => p.ip === "203.0.113.10")).toBe(false);
    expect(listPending().some((p) => p.case_id === CASE_B)).toBe(true);
  });

  it("後端不可達時清單空且操作回 backend_unreachable", () => {
    setBackendUnreachable(true);
    expect(isBackendUnreachable()).toBe(true);
    expect(listPending()).toEqual([]);
    const r = reviewApprove(CASE_A, "operator1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("backend_unreachable");
  });
});

describe("demoStore 待審信心帶過濾", () => {
  it("帶外信心不進清單；0.50 進、0.90 不進", () => {
    injectPendingForTests([
      {
        ip: "198.51.100.10",
        confidence: 0.49,
        case_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
      {
        ip: "198.51.100.11",
        confidence: 0.5,
        case_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
      {
        ip: "198.51.100.12",
        confidence: 0.9,
        case_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    ]);
    const ips = listPending().map((p) => p.ip);
    expect(ips).toEqual(["198.51.100.11"]);
  });
});
