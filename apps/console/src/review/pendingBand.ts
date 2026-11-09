import {
  AUTO_THRESHOLD,
  CASE_THRESHOLD,
  DEFAULT_THRESHOLDS,
  type Thresholds,
} from "./thresholds";

/**
 * 待審信心帶：對齊 contracts flow-verdict 的 CASE_THRESHOLD／AUTO_THRESHOLD，
 * 以及 docs/PLAN-ADDENDUM-V2-DECISIONS.md §2(1)：≥auto 自動；case–auto 待審。
 * 邊界：下限 inclusive（confidence >= case），上限 exclusive（confidence < auto）。
 * 預設常數保留為別名；執行時可傳入目前門檻（理想上由 demoStore 提供）。
 */
export const REVIEW_MIN_CONFIDENCE = CASE_THRESHOLD;
export const AUTO_MIN_CONFIDENCE = AUTO_THRESHOLD;

export function isPendingConfidence(
  confidence: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): boolean {
  return confidence >= thresholds.case && confidence < thresholds.auto;
}
