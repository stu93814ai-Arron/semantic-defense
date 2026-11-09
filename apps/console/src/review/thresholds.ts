import type { AuditRecord } from "./types";

/**
 * TODO: 待 A 組自 `@semantic-defense/contracts/browser` 再匯出 Thresholds／
 * DEFAULT_THRESHOLDS／CASE_THRESHOLD／AUTO_THRESHOLD 後，改為直接 import 該入口。
 * 形狀對齊 contracts admin-api ThresholdsSchema：{ case, auto }，0 ≤ case ≤ auto ≤ 1。
 */
export const CASE_THRESHOLD = 0.5;
export const AUTO_THRESHOLD = 0.9;

export type Thresholds = {
  case: number;
  auto: number;
};

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  case: CASE_THRESHOLD,
  auto: AUTO_THRESHOLD,
});

export type ThresholdValidateOk = { ok: true; value: Thresholds };
export type ThresholdValidateErr = { ok: false; code: "invalid_thresholds" };

export function validateThresholds(input: {
  case: number;
  auto: number;
}): ThresholdValidateOk | ThresholdValidateErr {
  const { case: c, auto: a } = input;
  if (!Number.isFinite(c) || !Number.isFinite(a)) {
    return { ok: false, code: "invalid_thresholds" };
  }
  if (c < 0 || a > 1 || c > a) {
    return { ok: false, code: "invalid_thresholds" };
  }
  return { ok: true, value: { case: c, auto: a } };
}

export type ThresholdUpdateOk = {
  ok: true;
  value: Thresholds;
  audit: AuditRecord;
};
export type ThresholdUpdateErr = { ok: false; code: "invalid_thresholds"; message: string };

/**
 * 純函式：驗證後產生新門檻與稽核列（每次變更必寫）。
 * 實際授權由 A 組 API 執行；本層只服務 demoStore／畫面。
 */
export function updateThresholds(
  input: { case: number; auto: number },
  opts: { actorId: string; now: string; prev: Thresholds },
): ThresholdUpdateOk | ThresholdUpdateErr {
  const v = validateThresholds(input);
  if (!v.ok) {
    return {
      ok: false,
      code: "invalid_thresholds",
      message: "門檻須滿足 0 ≤ case ≤ auto ≤ 1",
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
