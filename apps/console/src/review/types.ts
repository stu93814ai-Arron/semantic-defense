/** 待審黑名單候選（尚未生效）。鍵為 case_id（對齊 A 組契約欄位）。 */
export type PendingCandidate = {
  ip: string;
  confidence: number;
  case_id: string;
  created_at: string;
  /**
   * 舊欄位：僅相容驗收測試師既有測例；決策與清單鍵一律用 case_id。
   * @deprecated
   */
  candidate_id?: string;
};

/** 已上榜黑名單（可撤回）。 */
export type ListedEntry = {
  entry_id: string;
  ip: string;
  source: "manual" | "auto";
  confidence: number;
  case_id: string;
  created_at: string;
  expires_at: string;
  approved_by: string;
  approved_at: string;
  revoked_at: string | null;
};

export type AllowlistItem = {
  entry_id: string;
  cidr: string;
  reason: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
};

export type SourceFilter = "all" | "auto" | "manual";

/** 退回理由三類（V2-DECISIONS O7／§2）。 */
export const REJECT_REASONS = [
  "正常業務",
  "範圍過寬",
  "對象錯誤",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export type AuditRecord = {
  action: string;
  actor_id: string;
  at: string;
  target_id: string;
  detail?: string;
};

export type DecisionOk<T> = { ok: true; value: T; audit: AuditRecord };
export type DecisionErr = { ok: false; code: string; message: string };
export type Decision<T> = DecisionOk<T> | DecisionErr;
