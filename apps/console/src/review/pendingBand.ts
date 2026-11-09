/**
 * 待審信心帶：對齊 contracts flow-verdict 的 CASE_THRESHOLD／AUTO_THRESHOLD，
 * 以及 docs/PLAN-ADDENDUM-V2-DECISIONS.md §2(1)：≥0.90 自動；0.50–0.90 待審。
 * 邊界：下限 inclusive（confidence >= 0.5），上限 exclusive（confidence < 0.9），
 * 因 0.9 走自動上榜（open_case 用 >= CASE；自動用 >= AUTO）。
 */
export const REVIEW_MIN_CONFIDENCE = 0.5;
export const AUTO_MIN_CONFIDENCE = 0.9;

export function isPendingConfidence(confidence: number): boolean {
  return confidence >= REVIEW_MIN_CONFIDENCE && confidence < AUTO_MIN_CONFIDENCE;
}
