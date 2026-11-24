import {
  ADMIN_API_PATHS,
  AllowlistCreateSchema,
  AllowlistEntrySchema,
  AllowlistListSchema,
  AllowlistUpdateSchema,
  AutoListSettingSchema,
  BlocklistEntrySchema,
  BlocklistListSchema,
  PendingCandidateListSchema,
  ThresholdsSchema,
  type AllowlistCreate,
  type AllowlistUpdate,
  type AutoListSetting,
  type Thresholds,
} from "@semantic-defense/contracts/browser";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AdminApiOk<T> = { ok: true; value: T };
export type AdminApiErr = {
  ok: false;
  status: number;
  code:
    | "forbidden"
    | "conflict"
    | "backend_unreachable"
    | "not_found"
    | "bad_request"
    | "invalid_response"
    | "unauthorized"
    | "client_error";
  message: string;
};
export type AdminApiResult<T> = AdminApiOk<T> | AdminApiErr;

/** 讀 VITE_ADMIN_API_BASE；未設則同源（空字串）。結尾斜線會去掉。 */
export function adminApiBaseUrl(env: Record<string, string | undefined> = viteEnv()): string {
  const raw = env.VITE_ADMIN_API_BASE ?? "";
  return raw.replace(/\/$/, "");
}

function viteEnv(): Record<string, string | undefined> {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
  return meta.env ?? {};
}

export function fillPath(template: string, params: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(params)) {
    out = out.replace(`:${key}`, encodeURIComponent(value));
  }
  return out;
}

function joinUrl(base: string, path: string): string {
  return `${base}${path}`;
}

const CLIENT_ERROR_MAX = 200;
const UNREACHABLE_MESSAGE = "後端無法連線，請稍後再試";

async function readErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function truncateMessage(text: string): string {
  return text.length > CLIENT_ERROR_MAX ? text.slice(0, CLIENT_ERROR_MAX) : text;
}

function mappedErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as { error?: unknown; message?: unknown };
  if (typeof rec.error === "string") return truncateMessage(rec.error);
  if (typeof rec.message === "string") return truncateMessage(rec.message);
  return undefined;
}

function clientErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "請求無法完成";
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "string") return "請求無法完成";
  return truncateMessage(error);
}

const STATUS_CODE = {
  400: { code: "bad_request" as const, fallback: "請求格式錯誤" },
  401: { code: "unauthorized" as const, fallback: "未登入" },
  403: { code: "forbidden" as const, fallback: "權限不足" },
  404: { code: "not_found" as const, fallback: "查無資料" },
  409: { code: "conflict" as const, fallback: "狀態衝突" },
} as const;

function statusErr(status: number, body: unknown): AdminApiErr {
  const mapped = STATUS_CODE[status as keyof typeof STATUS_CODE];
  if (mapped) {
    return {
      ok: false,
      status,
      code: mapped.code,
      message: mappedErrorMessage(body) ?? mapped.fallback,
    };
  }
  // 其餘 4xx 只採用字串 error（截斷至約 200 字），非字串用預設文案。
  if (status >= 400 && status < 500) {
    return { ok: false, status, code: "client_error", message: clientErrorMessage(body) };
  }
  return {
    ok: false,
    status,
    code: "backend_unreachable",
    message: UNREACHABLE_MESSAGE,
  };
}

const UNREACHABLE: AdminApiErr = {
  ok: false,
  status: 0,
  code: "backend_unreachable",
  message: UNREACHABLE_MESSAGE,
};

async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<{ ok: true; body: unknown } | AdminApiErr> {
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: "include", ...init });
  } catch {
    return UNREACHABLE;
  }
  if (res.status === 204) return { ok: true, body: null };
  if (!res.ok) return statusErr(res.status, await readErrorBody(res));
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, status: res.status, code: "invalid_response", message: "回應格式不符契約" };
  }
}

type Schema<T> = {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
};

function parse<T>(schema: Schema<T>, body: unknown): AdminApiResult<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 200, code: "invalid_response", message: "回應格式不符契約" };
  }
  return { ok: true, value: parsed.data };
}

export type AdminApi = ReturnType<typeof createAdminApi>;

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

async function getItems<T>(
  fetchImpl: FetchLike,
  target: string,
  schema: Schema<{ items: T[] }>,
): Promise<AdminApiResult<T[]>> {
  const r = await request(fetchImpl, target, { method: "GET" });
  if (!r.ok) return r;
  const parsed = parse(schema, r.body);
  return parsed.ok ? { ok: true as const, value: parsed.value.items } : parsed;
}

async function postParsed<T>(
  fetchImpl: FetchLike,
  target: string,
  schema: Schema<T>,
): Promise<AdminApiResult<T>> {
  const r = await request(fetchImpl, target, jsonInit("POST"));
  if (!r.ok) return r;
  return parse(schema, r.body);
}

/**
 * 管理面 HTTP 客戶端：路徑與 schema 取自 contracts/browser。
 * 待審核准／退回走 ADMIN_API_PATHS，無請求本文。fetch 可注入以便測試。
 */
export function createAdminApi(opts: { fetch?: FetchLike; baseUrl?: string } = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? adminApiBaseUrl();
  const url = (path: string, params?: Record<string, string>) =>
    joinUrl(base, params ? fillPath(path, params) : path);

  return {
    async getThresholds(): Promise<AdminApiResult<Thresholds>> {
      const r = await request(fetchImpl, url(ADMIN_API_PATHS.thresholds), { method: "GET" });
      if (!r.ok) return r;
      return parse(ThresholdsSchema, r.body);
    },
    async putThresholds(input: Thresholds): Promise<AdminApiResult<Thresholds>> {
      const r = await request(fetchImpl, url(ADMIN_API_PATHS.thresholds), jsonInit("PUT", input));
      if (!r.ok) return r;
      return parse(ThresholdsSchema, r.body);
    },
    async getAutoList(): Promise<AdminApiResult<AutoListSetting>> {
      const r = await request(fetchImpl, url(ADMIN_API_PATHS.autoList), { method: "GET" });
      if (!r.ok) return r;
      return parse(AutoListSettingSchema, r.body);
    },
    async putAutoList(input: AutoListSetting): Promise<AdminApiResult<AutoListSetting>> {
      const r = await request(fetchImpl, url(ADMIN_API_PATHS.autoList), jsonInit("PUT", input));
      if (!r.ok) return r;
      return parse(AutoListSettingSchema, r.body);
    },
    listPending: () =>
      getItems(fetchImpl, url(ADMIN_API_PATHS.blacklistPending), PendingCandidateListSchema),
    listBlacklist: () =>
      getItems(fetchImpl, url(ADMIN_API_PATHS.blacklist), BlocklistListSchema),
    revokeBlacklist: (entryId: string) =>
      postParsed(fetchImpl, url(ADMIN_API_PATHS.blacklistRevoke, { entryId }), BlocklistEntrySchema),
    approvePending: (caseId: string) =>
      postParsed(
        fetchImpl,
        url(ADMIN_API_PATHS.blacklistPendingApprove, { caseId }),
        BlocklistEntrySchema,
      ),
    async rejectPending(caseId: string) {
      const r = await request(
        fetchImpl,
        url(ADMIN_API_PATHS.blacklistPendingReject, { caseId }),
        jsonInit("POST"),
      );
      if (!r.ok) return r;
      return { ok: true as const, value: undefined };
    },
    listWhitelist: () =>
      getItems(fetchImpl, url(ADMIN_API_PATHS.whitelist), AllowlistListSchema),
    async createWhitelist(input: AllowlistCreate) {
      const body = AllowlistCreateSchema.parse(input);
      const r = await request(fetchImpl, url(ADMIN_API_PATHS.whitelist), jsonInit("POST", body));
      if (!r.ok) return r;
      return parse(AllowlistEntrySchema, r.body);
    },
    async updateWhitelist(entryId: string, input: AllowlistUpdate) {
      const body = AllowlistUpdateSchema.parse(input);
      const r = await request(
        fetchImpl,
        url(ADMIN_API_PATHS.whitelistEntry, { entryId }),
        jsonInit("PATCH", body),
      );
      if (!r.ok) return r;
      return parse(AllowlistEntrySchema, r.body);
    },
    async deleteWhitelist(entryId: string) {
      const r = await request(
        fetchImpl,
        url(ADMIN_API_PATHS.whitelistEntry, { entryId }),
        { method: "DELETE" },
      );
      if (!r.ok) return r;
      return { ok: true as const, value: undefined };
    },
  };
}
