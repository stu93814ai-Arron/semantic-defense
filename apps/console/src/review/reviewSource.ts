import {
  createAdminApi,
  type AdminApi,
  type AdminApiErr,
  type AdminApiResult,
} from "./adminApi";
import * as demo from "./demoStore";
import { filterListed } from "./listed";
import type { AllowlistItem, ListedEntry, PendingCandidate, RejectReason } from "./types";
import type { Thresholds } from "./thresholds";
import type { AllowlistCreate, AllowlistUpdate } from "@semantic-defense/contracts/browser";

type Mode = "unknown" | "api" | "demo";

let mode: Mode = "unknown";
let api: AdminApi = createAdminApi();

export function resetReviewSource(next?: AdminApi): void {
  mode = "unknown";
  api = next ?? createAdminApi();
}

export function reviewSourceIsUnreachable(): boolean {
  return demo.isBackendUnreachable();
}

function noteErr(err: AdminApiErr): void {
  if (err.code === "backend_unreachable") demo.setBackendUnreachable(true);
}

function useDemo(err: AdminApiErr): boolean {
  if (mode === "api") return false;
  return err.code === "not_found";
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function readList<T>(
  call: () => Promise<AdminApiResult<T[]>>,
  fallback: () => T[],
): Promise<T[]> {
  if (mode === "demo") return fallback();
  const r = await call();
  if (r.ok) {
    mode = "api";
    return r.value;
  }
  noteErr(r);
  if (useDemo(r)) {
    mode = "demo";
    return fallback();
  }
  return fallback();
}

async function write<T>(
  call: () => Promise<AdminApiResult<T>>,
  fallback: () => { ok: boolean; [k: string]: unknown },
): Promise<AdminApiResult<T> | { ok: boolean; code?: string; message?: string; value?: T }> {
  if (mode === "demo") return fallback() as AdminApiResult<T>;
  const r = await call();
  if (r.ok) {
    mode = "api";
    return r;
  }
  noteErr(r);
  if (useDemo(r)) {
    mode = "demo";
    return fallback() as AdminApiResult<T>;
  }
  return r;
}

/**
 * 管理面資料源：優先 A 組 API；集合資源 404（例如 e2e 僅有登入面）時回退 demoStore。
 * 待審核准／退回不走 API（批次 4 尚未合併）。
 */
export const reviewSource = {
  isUnreachable: reviewSourceIsUnreachable,

  async listPending(): Promise<PendingCandidate[]> {
    return readList(() => api.listPending(), () => demo.listPending());
  },

  async listActive(filter: "all" | "auto" | "manual" = "all"): Promise<ListedEntry[]> {
    if (mode === "demo") return demo.listActive(filter);
    const r = await api.listBlacklist();
    if (r.ok) {
      mode = "api";
      return filterListed(r.value, filter, nowIso());
    }
    noteErr(r);
    if (useDemo(r) || r.code === "backend_unreachable") {
      if (useDemo(r)) mode = "demo";
      return demo.listActive(filter);
    }
    return [];
  },

  async listWhitelist(): Promise<AllowlistItem[]> {
    return readList(() => api.listWhitelist(), () => demo.listAllowlist());
  },

  async getThresholds(): Promise<AdminApiResult<Thresholds>> {
    if (mode === "demo") return { ok: true, value: demo.getThresholds() };
    const r = await api.getThresholds();
    if (r.ok) {
      mode = "api";
      return r;
    }
    noteErr(r);
    if (useDemo(r)) {
      mode = "demo";
      return { ok: true, value: demo.getThresholds() };
    }
    return r;
  },

  async updateThresholds(input: Thresholds, actorId: string) {
    return write(
      () => api.putThresholds(input),
      () => demo.reviewUpdateThresholds(input, actorId),
    );
  },

  async createWhitelist(input: AllowlistCreate, actorId: string) {
    return write(
      () => api.createWhitelist(input),
      () => demo.reviewAddAllowlist({ cidr: input.cidr, reason: input.reason }, actorId),
    );
  },

  async updateWhitelist(entryId: string, input: AllowlistUpdate, actorId: string) {
    return write(
      () => api.updateWhitelist(entryId, input),
      () => demo.reviewUpdateAllowlist(entryId, input, actorId),
    );
  },

  async deleteWhitelist(entryId: string, actorId: string) {
    return write(
      () => api.deleteWhitelist(entryId),
      () => demo.reviewRemoveAllowlist(entryId, actorId),
    );
  },

  async withdraw(entryId: string, actorId: string) {
    return write(
      () => api.revokeBlacklist(entryId),
      () => demo.reviewWithdraw(entryId, actorId),
    );
  },

  /** 核准仍走本地 demoStore，不呼叫尚未合併的 API。 */
  async approve(caseId: string, actorId: string) {
    return demo.reviewApprove(caseId, actorId);
  },

  /** 退回仍走本地 demoStore，不呼叫尚未合併的 API。 */
  async reject(caseId: string, actorId: string, reason: RejectReason | string) {
    return demo.reviewReject(caseId, actorId, reason);
  },
};
