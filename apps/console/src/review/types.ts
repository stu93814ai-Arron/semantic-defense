/** 待審黑名單候選（尚未生效）。 */
export type PendingCandidate = {
  candidate_id: string;
  ip: string;
  confidence: number;
  case_id: string;
  created_at: string;
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
