import { addAllowlist, removeAllowlist } from "./allowlistForm";
import { filterListed, withdrawListed } from "./listed";
import { approvePending, rejectPending } from "./pending";
import type {
  AllowlistItem,
  AuditRecord,
  ListedEntry,
  PendingCandidate,
  SourceFilter,
} from "./types";

const seedPending = (): PendingCandidate[] => [
  {
    candidate_id: "cand-1",
    ip: "203.0.113.10",
    confidence: 0.42,
    case_id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-11-05T00:00:00Z",
  },
  {
    candidate_id: "cand-2",
    ip: "203.0.113.20",
    confidence: 0.55,
    case_id: "55555555-5555-4555-8555-555555555555",
    created_at: "2026-11-05T00:10:00Z",
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
    expires_at: "2026-11-06T00:00:00Z",
    approved_by: "system:auto",
    approved_at: "2026-11-05T00:00:00Z",
    revoked_at: null,
  },
];

let pending = seedPending();
let listed = seedListed();
let allowlist: AllowlistItem[] = [];
let audits: AuditRecord[] = [];
let resolved = new Set<string>();

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function listPending(): PendingCandidate[] {
  return pending.filter((p) => !resolved.has(p.candidate_id));
}

export function listActive(filter: SourceFilter = "all"): ListedEntry[] {
  return filterListed(listed, filter);
}

export function listAllowlist(): AllowlistItem[] {
  return [...allowlist];
}

export function listAudits(): AuditRecord[] {
  return [...audits];
}

export function reviewApprove(candidateId: string, actorId: string) {
  const candidate = pending.find((p) => p.candidate_id === candidateId);
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
  resolved.add(candidateId);
  listed = [...listed, result.value];
  audits = [...audits, result.audit];
  return result;
}

export function reviewReject(candidateId: string, actorId: string) {
  const candidate = pending.find((p) => p.candidate_id === candidateId);
  if (!candidate) {
    return { ok: false as const, code: "not_found", message: "查無待審項目" };
  }
  const result = rejectPending(candidate, {
    actorId,
    now: nowIso(),
    alreadyApprovedIds: resolved,
  });
  if (!result.ok) return result;
  resolved.add(candidateId);
  audits = [...audits, result.audit];
  return result;
}

export function reviewWithdraw(entryId: string, actorId: string) {
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

/** 測試用：重置記憶體狀態。 */
export function resetDemoStoreForTests(): void {
  pending = seedPending();
  listed = seedListed();
  allowlist = [];
  audits = [];
  resolved = new Set();
}
