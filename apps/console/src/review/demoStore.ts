import { addAllowlist, removeAllowlist } from "./allowlistForm";
import { filterListed, withdrawListed } from "./listed";
import { ipOnAllowlist } from "./allowlistMatch";
import { approvePending, isPendingExpired, rejectPending } from "./pending";
import { isPendingConfidence } from "./pendingBand";
import {
  DEFAULT_THRESHOLDS,
  updateThresholds,
  type Thresholds,
} from "./thresholds";
import type {
  AllowlistItem,
  AuditRecord,
  ListedEntry,
  PendingCandidate,
  RejectReason,
  SourceFilter,
} from "./types";

function recentIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 候選 created_at 須接近現在，核准後 created_at+24h 才仍在 active。 */
const seedPending = (): PendingCandidate[] => [
  {
    ip: "203.0.113.10",
    confidence: 0.55,
    case_id: "11111111-1111-4111-8111-111111111111",
    created_at: recentIso(-3_600_000),
  },
  {
    ip: "203.0.113.20",
    confidence: 0.72,
    case_id: "55555555-5555-4555-8555-555555555555",
    created_at: recentIso(-2_400_000),
  },
];

const seedListed = (): ListedEntry[] => [
  {
    entry_id: "list-auto-1",
    ip: "198.51.100.1",
    source: "auto",
    confidence: 0.96,
    case_id: "22222222-2222-4222-8222-222222222222",
    created_at: "2026-11-05T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    approved_by: "system:auto",
    approved_at: "2026-11-05T00:00:00Z",
    revoked_at: null,
  },
];

let pending: PendingCandidate[] = [];
let listed: ListedEntry[] = [];
let allowlist: AllowlistItem[] = [];
let audits: AuditRecord[] = [];
let resolved = new Set<string>();
let backendUnreachable = false;
let thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function setBackendUnreachable(value: boolean): void {
  backendUnreachable = value;
}

export function isBackendUnreachable(): boolean {
  return backendUnreachable;
}

/**
 * 待審清單：信心帶內、未解決、不在白名單。
 * 已到期仍回傳（畫面上標 already_expired），不從清單消失。
 */
export function listPending(): PendingCandidate[] {
  if (backendUnreachable) {
    return [];
  }
  return pending.filter((p) => {
    if (resolved.has(p.case_id)) return false;
    if (!isPendingConfidence(p.confidence, thresholds)) return false;
    if (ipOnAllowlist(p.ip, allowlist)) return false;
    return true;
  });
}

export function listActive(filter: SourceFilter = "all"): ListedEntry[] {
  if (backendUnreachable) return [];
  return filterListed(listed, filter, nowIso());
}

export function listAllowlist(): AllowlistItem[] {
  return [...allowlist];
}

export function listAudits(): AuditRecord[] {
  return [...audits];
}

export function reviewApprove(caseId: string, actorId: string) {
  if (backendUnreachable) {
    return {
      ok: false as const,
      code: "backend_unreachable",
      message: "後端無法連線，請稍後再試",
    };
  }
  const candidate = pending.find((p) => p.case_id === caseId);
  if (!candidate) {
    return { ok: false as const, code: "not_found", message: "查無待審項目" };
  }
  const result = approvePending(candidate, {
    actorId,
    now: nowIso(),
    allowlist,
    alreadyApprovedIds: resolved,
  });
  if (!result.ok) return result;
  resolved.add(caseId);
  listed = [...listed, result.value];
  audits = [...audits, result.audit];
  return result;
}

export function reviewReject(
  caseId: string,
  actorId: string,
  reason: RejectReason | string,
) {
  if (backendUnreachable) {
    return {
      ok: false as const,
      code: "backend_unreachable",
      message: "後端無法連線，請稍後再試",
    };
  }
  const candidate = pending.find((p) => p.case_id === caseId);
  if (!candidate) {
    return { ok: false as const, code: "not_found", message: "查無待審項目" };
  }
  const result = rejectPending(candidate, {
    actorId,
    now: nowIso(),
    alreadyApprovedIds: resolved,
    reason,
  });
  if (!result.ok) return result;
  resolved.add(caseId);
  audits = [...audits, result.audit];
  return result;
}

export function reviewWithdraw(entryId: string, actorId: string) {
  if (backendUnreachable) {
    return {
      ok: false as const,
      code: "backend_unreachable",
      message: "後端無法連線，請稍後再試",
    };
  }
  const entry = listed.find((e) => e.entry_id === entryId);
  if (!entry) {
    return { ok: false as const, code: "not_found", message: "查無上榜項目" };
  }
  const result = withdrawListed(entry, { actorId, now: nowIso() });
  if (!result.ok) return result;
  listed = listed.map((e) => (e.entry_id === entryId ? result.value : e));
  audits = [...audits, result.audit];
  return result;
}

export function reviewAddAllowlist(
  input: { cidr: string; reason: string },
  actorId: string,
) {
  const result = addAllowlist(input, { actorId, now: nowIso() });
  if (!result.ok) return result;
  allowlist = [...allowlist, result.value];
  audits = [...audits, result.audit];
  return result;
}

export function reviewRemoveAllowlist(entryId: string, actorId: string) {
  const item = allowlist.find((e) => e.entry_id === entryId);
  if (!item) {
    return { ok: false as const, code: "not_found", message: "查無白名單項目" };
  }
  const result = removeAllowlist(item, { actorId, now: nowIso() });
  if (!result.ok) return result;
  allowlist = allowlist.filter((e) => e.entry_id !== entryId);
  audits = [...audits, result.audit];
  return result;
}

export function getThresholds(): Thresholds {
  return { ...thresholds };
}

/**
 * 更新門檻並寫稽核（每次變更）。僅接 demoStore；授權由 A 組 API 執行。
 */
export function reviewUpdateThresholds(
  input: { case: number; auto: number },
  actorId: string,
) {
  const result = updateThresholds(input, {
    actorId,
    now: nowIso(),
    prev: thresholds,
  });
  if (!result.ok) return result;
  thresholds = result.value;
  audits = [...audits, result.audit];
  return result;
}

/** 測試用：清空記憶體狀態（頁面預設空狀態）。 */
export function resetDemoStoreForTests(): void {
  pending = [];
  listed = [];
  allowlist = [];
  audits = [];
  resolved = new Set();
  backendUnreachable = false;
  thresholds = { ...DEFAULT_THRESHOLDS };
}

/** 測試用：填入示範待審／上榜資料。 */
export function seedFixturesForTests(): void {
  pending = seedPending();
  listed = seedListed();
  allowlist = [];
  audits = [];
  resolved = new Set();
  backendUnreachable = false;
  thresholds = { ...DEFAULT_THRESHOLDS };
}

/** 測試用：注入待審列（含到期／帶外信心等）。 */
export function injectPendingForTests(items: PendingCandidate[]): void {
  pending = [...items];
}

export { isPendingExpired };
