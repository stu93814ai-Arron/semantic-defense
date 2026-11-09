import { DEFAULT_THRESHOLDS, type Thresholds } from "./thresholds";

/**
 * 待審信心帶：對齊預設／目前門檻的 case／auto，
 * 以及 docs/PLAN-ADDENDUM-V2-DECISIONS.md §2(1)：≥auto 自動；case–auto 待審。
 * 邊界：下限 inclusive（confidence >= case），上限 exclusive（confidence < auto）。
 */
export const REVIEW_MIN_CONFIDENCE = DEFAULT_THRESHOLDS.case;
export const AUTO_MIN_CONFIDENCE = DEFAULT_THRESHOLDS.auto;

export function isPendingConfidence(
  confidence: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): boolean {
  return confidence >= thresholds.case && confidence < thresholds.auto;
}
