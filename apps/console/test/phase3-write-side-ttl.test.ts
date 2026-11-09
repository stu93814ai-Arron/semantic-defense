import { describe, expect, it } from "vitest";
import { approvePending, isPendingExpired } from "../src/review/pending.js";
import type { PendingCandidate } from "../src/review/types.js";

/**
 * docs/PLAN-ADDENDUM-V2-DECISIONS.md §2b：
 * - 待審在 created_at + 24h 到期，累加不延長；
 * - 封鎖以核准成功的伺服器時間為準，listed_at + 24h 到期。
 * 本 console 面：listed_at == approved_at（無獨立 listed_at 欄位）。
 * PLAN-ADDENDUM-MONITOR.md §3：created_at ≤ approved_at ≤ expires_at。
 *
 * 公開 API 沿用現測：approvePending／isPendingExpired（BlacklistReviewPage／demoStore
 * 的 already_expired 標記同源）。無「累加命中」專用 API → 以同一 created_at 更新
 * confidence 驗證到期窗不延長；若日後有累加 API，應改接該面。
 */
describe("第 3 階段到期規則（V2 §2b）", () => {
  const CREATED = "2026-11-05T00:00:00Z";
  const PENDING_EXPIRES = "2026-11-06T00:00:00Z"; // created_at + 24h
  const WITHIN = "2026-11-05T01:00:00Z"; // T ≠ created_at
  const AFTER = "2026-11-06T00:00:01Z"; // 已過待審窗
  const LISTED_EXPIRES_AT_T = "2026-11-06T01:00:00Z"; // WITHIN + 24h

  const base = (): PendingCandidate => ({
    ip: "203.0.113.77",
    confidence: 0.55,
    case_id: "11111111-1111-4111-8111-111111111111",
    created_at: CREATED,
  });

  const ctx = (now: string) => ({
    actorId: "operator1",
    now,
    allowlist: [] as const,
    alreadyApprovedIds: new Set<string>(),
  });

  describe("（1）待審窗：created_at+24h；累加不延長；逾時 already_expired", () => {
    it("isPendingExpired：created_at+24h 當下起為到期", () => {
      const c = base();
      expect(isPendingExpired(c, "2026-11-05T23:59:59Z")).toBe(false);
      expect(isPendingExpired(c, PENDING_EXPIRES)).toBe(true);
      expect(isPendingExpired(c, AFTER)).toBe(true);
    });

    it("同一 created_at 下更新 confidence（模擬累加命中）不延長待審窗", () => {
      const c = base();
      const bumped: PendingCandidate = { ...c, confidence: 0.88 };
      expect(isPendingExpired(bumped, "2026-11-05T23:59:59Z")).toBe(false);
      expect(isPendingExpired(bumped, PENDING_EXPIRES)).toBe(true);
      const late = approvePending(bumped, ctx(AFTER));
      expect(late.ok).toBe(false);
      if (late.ok) return;
      expect(late.code).toBe("already_expired");
    });

    it("逾時核准 → already_expired，且不產生上榜項目", () => {
      const r = approvePending(base(), ctx(AFTER));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("already_expired");
      expect(r.message).toMatch(/到期/);
      // DecisionErr 無 value → 呼叫端不得寫入 active list
      expect("value" in r).toBe(false);
    });
  });

  describe("（2）窗內核准：listed_at(=approved_at)=T，expires_at=T+24h", () => {
    it("now=T≠created_at → approved_at=T、expires_at=T+24h，且 created_at≤approved_at≤expires_at", () => {
      const r = approvePending(base(), ctx(WITHIN));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // console：listed_at == approved_at
      expect(r.value.approved_at).toBe(WITHIN);
      // V2 §2b：封鎖 listed_at + 24h（非待審的 created_at + 24h）
      expect(r.value.expires_at).toBe(LISTED_EXPIRES_AT_T);
      expect(r.value.created_at).toBe(CREATED);
      // MONITOR §3
      expect(Date.parse(r.value.created_at)).toBeLessThanOrEqual(
        Date.parse(r.value.approved_at),
      );
      expect(Date.parse(r.value.approved_at)).toBeLessThanOrEqual(
        Date.parse(r.value.expires_at),
      );
      // 與待審窗區隔：不得仍寫成 created_at+24h
      expect(r.value.expires_at).not.toBe(PENDING_EXPIRES);
    });
  });
});
