import { describe, expect, it } from "vitest";
import {
  approvePending,
  rejectPending,
  type ApproveContext,
} from "./pending";
import type { PendingCandidate } from "./types";

const base: PendingCandidate = {
  candidate_id: "c1",
  ip: "203.0.113.10",
  confidence: 0.4,
  case_id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-11-05T00:00:00Z",
};

const ctx = (over: Partial<ApproveContext> = {}): ApproveContext => ({
  actorId: "operator1",
  now: "2026-11-05T01:00:00Z",
  allowlist: [],
  alreadyApprovedIds: new Set(),
  ...over,
});

describe("待審核准／退回", () => {
  it("核准產生 manual 上榜項與稽核", () => {
    const r = approvePending(base, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.source).toBe("manual");
    expect(r.value.ip).toBe(base.ip);
    expect(r.value.revoked_at).toBeNull();
    expect(r.audit.action).toBe("blacklist.approve");
    expect(r.audit.actor_id).toBe("operator1");
  });

  it("退回寫稽核且不上榜", () => {
    const r = rejectPending(base, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ candidate_id: "c1", status: "rejected" });
    expect(r.audit.action).toBe("blacklist.reject");
  });

  it("白名單命中時核准被拒並提示", () => {
    const r = approvePending(
      base,
      ctx({
        allowlist: [
          {
            entry_id: "a1",
            cidr: "203.0.113.10",
            reason: "夥伴",
            created_by: "admin1",
            created_at: "2026-11-01T00:00:00Z",
            expires_at: null,
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("on_allowlist");
    expect(r.message).toMatch(/白名單/);
  });

  it("兩人同時核准只留一筆（已核准 id 擋下第二人）", () => {
    const first = approvePending(base, ctx({ actorId: "op-a" }));
    expect(first.ok).toBe(true);
    const second = approvePending(
      base,
      ctx({
        actorId: "op-b",
        alreadyApprovedIds: new Set([base.candidate_id]),
      }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("already_resolved");
  });
});

describe("待審核准與白名單 IPv6", () => {
  it("白名單 IPv6 CIDR 網段命中時核准被拒", () => {
    const cand: PendingCandidate = {
      ...base,
      candidate_id: "c-v6",
      ip: "2001:db8::abcd",
    };
    const r = approvePending(
      cand,
      ctx({
        allowlist: [
          {
            entry_id: "a-v6",
            cidr: "2001:db8::/32",
            reason: "實驗室",
            created_by: "admin1",
            created_at: "2026-11-01T00:00:00Z",
            expires_at: null,
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("on_allowlist");
  });
});

describe("待審核准預設到期（created_at + 24h）", () => {
  it("expires_at 以候選 created_at 加 24h，不用核准當下 now", () => {
    const r = approvePending(base, ctx({ now: "2026-11-05T01:00:00Z" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created_at).toBe("2026-11-05T00:00:00Z");
    expect(r.value.approved_at).toBe("2026-11-05T01:00:00Z");
    expect(r.value.expires_at).toBe("2026-11-06T00:00:00Z");
  });

  it("created_at+24h 已過則回 already_expired，不上榜", () => {
    const r = approvePending(base, ctx({ now: "2026-11-06T01:00:00Z" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("already_expired");
    expect(r.message).toMatch(/到期/);
    expect(r.code).not.toBe("approved_window");
  });
});
