import { describe, expect, it } from "vitest";
import {
  THRESHOLD_BOUNDS,
  thresholdsViolation,
} from "@semantic-defense/contracts/browser";
import {
  DEFAULT_THRESHOLDS,
  formatThresholdsViolation,
  updateThresholds,
  validateThresholds,
} from "./thresholds";

describe("門檻 Thresholds（contracts/browser THRESHOLD_BOUNDS）", () => {
  it("預設仍為 case=0.5、auto=0.9", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ case: 0.5, auto: 0.9 });
  });

  it("bounds 對齊 contracts：case≥0.30、auto≥0.70、皆≤1", () => {
    expect(THRESHOLD_BOUNDS.case.min).toBe(0.3);
    expect(THRESHOLD_BOUNDS.case.max).toBe(1);
    expect(THRESHOLD_BOUNDS.auto.min).toBe(0.7);
    expect(THRESHOLD_BOUNDS.auto.max).toBe(1);
  });

  it("接受合法值（含下限、嚴格 case < auto）", () => {
    expect(validateThresholds({ case: 0.3, auto: 0.7 }).ok).toBe(true);
    expect(validateThresholds({ case: 0.5, auto: 0.9 }).ok).toBe(true);
    expect(validateThresholds({ case: 0.99, auto: 1 }).ok).toBe(true);
  });

  it("拒舊規則曾接受的過低下限與 case===auto", () => {
    expect(validateThresholds({ case: 0, auto: 0.9 }).ok).toBe(false);
    expect(validateThresholds({ case: 0.5, auto: 0.69 }).ok).toBe(false);
    expect(validateThresholds({ case: 0.8, auto: 0.8 }).ok).toBe(false);
    expect(thresholdsViolation({ case: 0.29, auto: 0.9 })).toBe("case_below_min");
    expect(thresholdsViolation({ case: 0.5, auto: 0.69 })).toBe("auto_below_min");
    expect(thresholdsViolation({ case: 0.8, auto: 0.8 })).toBe("case_not_below_auto");
  });

  it("formatThresholdsViolation 回可顯示文案", () => {
    expect(formatThresholdsViolation("case_below_min")).toMatch(/0\.3/);
    expect(formatThresholdsViolation("auto_below_min")).toMatch(/0\.7/);
    expect(formatThresholdsViolation("case_not_below_auto")).toMatch(/</);
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
  });

  it("更新失敗帶 violation 訊息", () => {
    const r = updateThresholds(
      { case: 0.95, auto: 0.5 },
      { actorId: "admin1", now: "2026-11-09T08:00:00Z", prev: DEFAULT_THRESHOLDS },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_thresholds");
    expect(r.message.length).toBeGreaterThan(0);
  });
});
