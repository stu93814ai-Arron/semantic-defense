import {
  THRESHOLD_BOUNDS,
  ThresholdsSchema,
  thresholdsViolation,
  type Thresholds,
  type ThresholdsViolation,
} from "@semantic-defense/contracts/browser";
import type { AuditRecord } from "./types";

export type { Thresholds, ThresholdsViolation };
export { THRESHOLD_BOUNDS, thresholdsViolation };

/** 預設門檻（MONITOR §7：0.50／0.90）。browser 入口未再匯出 DEFAULT／CASE／AUTO 常數。 */
export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  case: 0.5,
  auto: 0.9,
});

export type ThresholdValidateOk = { ok: true; value: Thresholds };
export type ThresholdValidateErr = {
  ok: false;
  code: "invalid_thresholds";
  violation: ThresholdsViolation | "invalid_shape";
  message: string;
};

/** 將 thresholdsViolation 代碼轉成畫面文案（含上下限）。 */
export function formatThresholdsViolation(v: ThresholdsViolation | "invalid_shape"): string {
  const B = THRESHOLD_BOUNDS;
  switch (v) {
    case "case_below_min":
      return `成案門檻須 ≥ ${B.case.min}`;
    case "case_above_max":
      return `成案門檻須 ≤ ${B.case.max}`;
    case "auto_below_min":
      return `自動上榜門檻須 ≥ ${B.auto.min}`;
    case "auto_above_max":
      return `自動上榜門檻須 ≤ ${B.auto.max}`;
    case "case_not_below_auto":
      return "成案門檻須嚴格小於自動上榜門檻（case < auto）";
    case "invalid_shape":
      return "門檻須為兩個有限數字";
    default: {
      const _exhaustive: never = v;
      return _exhaustive;
    }
  }
}

/**
 * 委派 contracts ThresholdsSchema／thresholdsViolation（case≥0.30、auto≥0.70、case<auto）。
 */
export function validateThresholds(input: {
  case: number;
  auto: number;
}): ThresholdValidateOk | ThresholdValidateErr {
  const parsed = ThresholdsSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  if (!Number.isFinite(input.case) || !Number.isFinite(input.auto)) {
    return {
      ok: false,
      code: "invalid_thresholds",
      violation: "invalid_shape",
      message: formatThresholdsViolation("invalid_shape"),
    };
  }
  const violation = thresholdsViolation(input) ?? "invalid_shape";
  return {
    ok: false,
    code: "invalid_thresholds",
    violation,
    message: formatThresholdsViolation(violation),
  };
}

export type ThresholdUpdateOk = {
  ok: true;
  value: Thresholds;
  audit: AuditRecord;
};
export type ThresholdUpdateErr = {
  ok: false;
  code: "invalid_thresholds";
  message: string;
  violation?: ThresholdsViolation | "invalid_shape";
};

/** 純函式：驗證後產生新門檻與稽核列。授權由 A 組 API 執行。 */
export function updateThresholds(
  input: { case: number; auto: number },
  opts: { actorId: string; now: string; prev: Thresholds },
): ThresholdUpdateOk | ThresholdUpdateErr {
  const v = validateThresholds(input);
  if (!v.ok) {
    return {
      ok: false,
      code: "invalid_thresholds",
      message: v.message,
      violation: v.violation,
    };
  }
  return {
    ok: true,
    value: v.value,
    audit: {
      at: opts.now,
      actor_id: opts.actorId,
      action: "thresholds.update",
      target_id: "thresholds",
      detail: `case ${opts.prev.case}→${v.value.case}; auto ${opts.prev.auto}→${v.value.auto}`,
    },
  };
}
