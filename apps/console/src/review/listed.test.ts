import { describe, expect, it } from "vitest";
import { filterListed, withdrawListed } from "./listed";
import type { ListedEntry } from "./types";

const entries: ListedEntry[] = [
  {
    entry_id: "e-auto",
    ip: "198.51.100.1",
    source: "auto",
    confidence: 0.95,
    case_id: "22222222-2222-4222-8222-222222222222",
    created_at: "2026-11-05T00:00:00Z",
    expires_at: "2026-11-06T00:00:00Z",
    approved_by: "system:auto",
    approved_at: "2026-11-05T00:00:00Z",
    revoked_at: null,
  },
  {
    entry_id: "e-manual",
    ip: "198.51.100.2",
    source: "manual",
    confidence: 0.4,
    case_id: "33333333-3333-4333-8333-333333333333",
    created_at: "2026-11-05T00:00:00Z",
    expires_at: "2026-11-06T00:00:00Z",
    approved_by: "operator1",
    approved_at: "2026-11-05T00:30:00Z",
    revoked_at: null,
  },
  {
    entry_id: "e-revoked",
    ip: "198.51.100.3",
    source: "auto",
    confidence: 0.9,
    case_id: "44444444-4444-4444-8444-444444444444",
    created_at: "2026-11-04T00:00:00Z",
    expires_at: "2026-11-05T00:00:00Z",
    approved_by: "system:auto",
    approved_at: "2026-11-04T00:00:00Z",
    revoked_at: "2026-11-04T12:00:00Z",
  },
];

describe("已上榜篩選與撤回", () => {
  it("可篩自動／人工／全部（不含已撤回）", () => {
    expect(filterListed(entries, "all").map((e) => e.entry_id)).toEqual([
      "e-auto",
      "e-manual",
    ]);
    expect(filterListed(entries, "auto").map((e) => e.entry_id)).toEqual([
      "e-auto",
    ]);
    expect(filterListed(entries, "manual").map((e) => e.entry_id)).toEqual([
      "e-manual",
    ]);
  });

  it("一鍵撤回寫入 revoked_at 與稽核", () => {
    const r = withdrawListed(entries[0]!, {
      actorId: "operator1",
      now: "2026-11-05T02:00:00Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.revoked_at).toBe("2026-11-05T02:00:00Z");
    expect(r.audit.action).toBe("blacklist.withdraw");
  });

  it("已撤回不可再撤", () => {
    const r = withdrawListed(entries[2]!, {
      actorId: "operator1",
      now: "2026-11-05T02:00:00Z",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("already_revoked");
  });
});
