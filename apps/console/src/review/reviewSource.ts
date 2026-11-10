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

function viteEnv(): Record<string, string | undefined> {
  // 必須寫成 import.meta.env.VITE_* 靜態存取，Vite 才會把 dev／e2e 旗標打進套件。
  return { VITE_DEMO_FALLBACK: import.meta.env.VITE_DEMO_FALLBACK };
}

/** 僅當 VITE_DEMO_FALLBACK=1 時，集合資源 404 才回退 demoStore（dev／e2e）。 */
export function demoFallbackEnabled(
  env: Record<string, string | undefined> = viteEnv(),
): boolean {
  return env.VITE_DEMO_FALLBACK === "1";
}

let mode: Mode = "unknown";
let api: AdminApi = createAdminApi();
let fallbackOn = demoFallbackEnabled();

export function resetReviewSource(
  next?: AdminApi,
  env?: Record<string, string | undefined>,
): void {
  mode = "unknown";
  api = next ?? createAdminApi();
  fallbackOn = demoFallbackEnabled(env ?? viteEnv());
}

export function reviewSourceIsUnreachable(): boolean {
  return demo.isBackendUnreachable();
}

function noteErr(err: AdminApiErr): void {
  if (err.code === "backend_unreachable") demo.setBackendUnreachable(true);
}

function useDemo(err: AdminApiErr): boolean {
  if (mode === "api") return false;
  return fallbackOn && err.code === "not_found";
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function readList<T>(
  call: () => Promise<AdminApiResult<T[]>>,
  fallback: () => T[],
): Promise<AdminApiResult<T[]>> {
  if (mode === "demo") return { ok: true, value: fallback() };
  const r = await call();
  if (r.ok) {
    mode = "api";
    return r;
  }
  noteErr(r);
  if (useDemo(r)) {
    mode = "demo";
    return { ok: true, value: fallback() };
  }
  return r;
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
 * 管理面資料源：優先 A 組 API。
 * 僅當 VITE_DEMO_FALLBACK=1 且為 404 時回退 demoStore（dev／e2e）；其餘錯誤原樣回傳。
 * 待審核准／退回不走 API（批次 4 尚未合併）。
 */
export const reviewSource = {
  isUnreachable: reviewSourceIsUnreachable,

  async listPending(): Promise<AdminApiResult<PendingCandidate[]>> {
    return readList(() => api.listPending(), () => demo.listPending());
  },

  async listActive(
    filter: "all" | "auto" | "manual" = "all",
  ): Promise<AdminApiResult<ListedEntry[]>> {
    if (mode === "demo") return { ok: true, value: demo.listActive(filter) };
    const r = await api.listBlacklist();
    if (r.ok) {
      mode = "api";
      return { ok: true, value: filterListed(r.value, filter, nowIso()) };
    }
    noteErr(r);
    if (useDemo(r)) {
      mode = "demo";
      return { ok: true, value: demo.listActive(filter) };
    }
    return r;
  },

  async listWhitelist(): Promise<AdminApiResult<AllowlistItem[]>> {
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
