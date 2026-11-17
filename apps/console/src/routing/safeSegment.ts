/** 動態路徑段：字元集對齊契約共用 Id（A–Z、a–z、0–9、_ . : -）。
 *  首字必須為英數字，以免「.」「..」通過後被路徑正規化
 *  （encodeURIComponent 不編碼點號，/api/judgments/.. 會變成 /api/）。 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** 契約沒有 GET /api/judgments/:id 的專用編號格式；待審 case_id 的 uuid 不適用（e2e 為 case-fixture-1）。
 *  字元集同上，長度上限 64。 */
export const JUDGMENT_CASE_ID_MAX = 64;
const JUDGMENT_CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function isSafePathSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value);
}

export function isJudgmentCaseId(value: string): boolean {
  return JUDGMENT_CASE_ID.test(value);
}
