import type {
  AllowlistEntry,
  BlocklistEntry,
  PendingCandidate as ContractPendingCandidate,
} from "@semantic-defense/contracts/browser";

/**
 * 待審黑名單候選：對齊 contracts PendingCandidate；保留 candidate_id? 相容驗收測。
 * 決策與清單鍵一律用 case_id。
 */
export type PendingCandidate = ContractPendingCandidate & {
  /**
   * 舊欄位：僅相容驗收測試師既有測例。
   * @deprecated
   */
  candidate_id?: string;
};

/**
 * 已上榜黑名單：欄位對齊 contracts BlocklistEntry。
 * entry_id 在 demo seed 可為非 UUID 字串，故放寬為 string。
 */
export type ListedEntry = Omit<BlocklistEntry, "entry_id"> & {
  entry_id: string;
};

/**
 * 白名單項目：欄位對齊 contracts AllowlistEntry；entry_id／created_by 在 demo 放寬。
 */
export type AllowlistItem = Omit<AllowlistEntry, "entry_id" | "created_by"> & {
  entry_id: string;
  created_by: string;
};

export type SourceFilter = "all" | "auto" | "manual";

/** 退回理由三類（V2-DECISIONS O7／§2）；非自由文字，不走 Reason schema。 */
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
