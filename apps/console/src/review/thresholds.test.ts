import { describe, expect, it } from "vitest";
import {
  AUTO_THRESHOLD,
  CASE_THRESHOLD,
  DEFAULT_THRESHOLDS,
  updateThresholds,
  validateThresholds,
} from "./thresholds";

describe("門檻 Thresholds（對齊 contracts admin-api／flow-verdict）", () => {
  it("預設 case=0.5、auto=0.9（CASE_THRESHOLD／AUTO_THRESHOLD）", () => {
    expect(CASE_THRESHOLD).toBe(0.5);
    expect(AUTO_THRESHOLD).toBe(0.9);
    expect(DEFAULT_THRESHOLDS).toEqual({ case: 0.5, auto: 0.9 });
  });

  it("接受 0 ≤ case ≤ auto ≤ 1", () => {
    expect(validateThresholds({ case: 0, auto: 0 }).ok).toBe(true);
    expect(validateThresholds({ case: 0.5, auto: 0.9 }).ok).toBe(true);
    expect(validateThresholds({ case: 1, auto: 1 }).ok).toBe(true);
  });

  it("拒 case > auto、越界、非有限數", () => {
    expect(validateThresholds({ case: 0.95, auto: 0.9 }).ok).toBe(false);
    expect(validateThresholds({ case: -0.1, auto: 0.9 }).ok).toBe(false);
    expect(validateThresholds({ case: 0.5, auto: 1.1 }).ok).toBe(false);
    expect(validateThresholds({ case: Number.NaN, auto: 0.9 }).ok).toBe(false);
  });

  it("更新成功寫稽核並回新值", () => {
    const r = updateThresholds(
      { case: 0.4, auto: 0.85 },
      { actorId: "admin1", now: "2026-11-09T08:00:00Z", prev: DEFAULT_THRESHOLDS },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ case: 0.4, auto: 0.85 });
    expect(r.audit.action).toBe("thresholds.update");
    expect(r.audit.actor_id).toBe("admin1");
    expect(r.audit.target_id).toBe("thresholds");
    expect(r.audit.detail).toMatch(/0\.4/);
  });

  it("更新失敗不寫稽核", () => {
    const r = updateThresholds(
      { case: 0.95, auto: 0.5 },
      { actorId: "admin1", now: "2026-11-09T08:00:00Z", prev: DEFAULT_THRESHOLDS },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_thresholds");
  });
});
