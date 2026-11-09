import { ipOnAllowlist } from "./allowlistMatch";
import type {
  AllowlistItem,
  Decision,
  ListedEntry,
  PendingCandidate,
  RejectReason,
} from "./types";
import { REJECT_REASONS } from "./types";

export type ApproveContext = {
  actorId: string;
  now: string;
  allowlist: AllowlistItem[];
  /** 已解決（核准或退回）的 case_id；兩人同時操作時第二人失敗。 */
  alreadyApprovedIds: ReadonlySet<string>;
  /** 預設封鎖時數；契約預設 24h。 */
  ttlHours?: number;
};

export type RejectResult = {
  case_id: string;
  status: "rejected";
  reason: RejectReason;
};

function hoursLater(iso: string, hours: number): string {
  const ms = Date.parse(iso) + hours * 3_600_000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isRejectReason(raw: string): raw is RejectReason {
  return (REJECT_REASONS as readonly string[]).includes(raw);
}

export function approvePending(
  candidate: PendingCandidate,
  ctx: ApproveContext,
): Decision<ListedEntry> {
  if (ctx.alreadyApprovedIds.has(candidate.case_id)) {
    return {
      ok: false,
      code: "already_resolved",
      message: "此案已由他人處理，僅保留一筆結果",
    };
  }
  if (ipOnAllowlist(candidate.ip, ctx.allowlist)) {
    return {
      ok: false,
      code: "on_allowlist",
      message: "此 IP 在白名單內，無法核准列入黑名單",
    };
  }
  const ttl = ctx.ttlHours ?? 24;
  const expiresAt = hoursLater(candidate.created_at, ttl);
  // 附錄：expires_at = created_at + 24h；若 now 已過期窗，不得寫入（避免落到 contracts approved_window）
  if (Date.parse(expiresAt) <= Date.parse(ctx.now)) {
    return {
      ok: false,
      code: "already_expired",
      message: "此項目已到期，無法核准",
    };
  }
  const entry: ListedEntry = {
    entry_id: candidate.case_id,
    ip: candidate.ip,
    source: "manual",
    confidence: candidate.confidence,
    case_id: candidate.case_id,
    created_at: candidate.created_at,
    expires_at: expiresAt,
    approved_by: ctx.actorId,
    approved_at: ctx.now,
    revoked_at: null,
  };
  return {
    ok: true,
    value: entry,
    audit: {
      action: "blacklist.approve",
      actor_id: ctx.actorId,
      at: ctx.now,
      target_id: candidate.case_id,
      detail: candidate.ip,
    },
  };
}

export function rejectPending(
  candidate: PendingCandidate,
  ctx: Pick<ApproveContext, "actorId" | "now" | "alreadyApprovedIds"> & {
    reason: string;
  },
): Decision<RejectResult> {
  if (ctx.alreadyApprovedIds.has(candidate.case_id)) {
    return {
      ok: false,
      code: "already_resolved",
      message: "此案已由他人處理，僅保留一筆結果",
    };
  }
  if (!isRejectReason(ctx.reason)) {
    return {
      ok: false,
      code: "invalid_reason",
      message: "退回理由須為：正常業務、範圍過寬、對象錯誤",
    };
  }
  return {
    ok: true,
    value: {
      case_id: candidate.case_id,
      status: "rejected",
      reason: ctx.reason,
    },
    audit: {
      action: "blacklist.reject",
      actor_id: ctx.actorId,
      at: ctx.now,
      target_id: candidate.case_id,
      detail: `${candidate.ip}|${ctx.reason}`,
    },
  };
}

/** 待審清單列：是否已到期（created_at + 24h ≤ now）。 */
export function isPendingExpired(
  candidate: PendingCandidate,
  now: string,
  ttlHours = 24,
): boolean {
  return Date.parse(hoursLater(candidate.created_at, ttlHours)) <= Date.parse(now);
}
