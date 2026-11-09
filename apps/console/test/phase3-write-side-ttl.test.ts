import { describe, expect, it } from "vitest";
import { approvePending } from "../src/review/pending.js";
import type { PendingCandidate } from "../src/review/types.js";

/**
 * PLAN-ADDENDUM-MONITOR.md §3／§8 第 3 階段驗收：
 * 「預設 expires_at = created_at + 24h（寫入端負責，schema 不補值）」。
 * 核准寫入時必須以候選的 created_at 為基準加 24 小時，不得改用核准當下 now。
 */
describe("第 3 階段寫入端：預設到期 24 小時", () => {
  const candidate: PendingCandidate = {
    candidate_id: "cand-ttl-1",
    ip: "203.0.113.77",
    confidence: 0.4,
    case_id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-11-05T00:00:00Z",
  };

  it("核准後 expires_at === created_at + 24h（即使 now 與 created_at 不同）", () => {
    const r = approvePending(candidate, {
      actorId: "operator1",
      now: "2026-11-05T01:00:00Z",
      allowlist: [],
      alreadyApprovedIds: new Set(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created_at).toBe("2026-11-05T00:00:00Z");
    expect(r.value.approved_at).toBe("2026-11-05T01:00:00Z");
    // 附錄：expires_at = created_at + 24h
    expect(r.value.expires_at).toBe("2026-11-06T00:00:00Z");
  });
});
