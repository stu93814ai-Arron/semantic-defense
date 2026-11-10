import {
  ADMIN_API_PATHS,
  AllowlistCreateSchema,
  AllowlistEntrySchema,
  AllowlistListSchema,
  AllowlistUpdateSchema,
  BlocklistEntrySchema,
  BlocklistListSchema,
  PendingCandidateListSchema,
  ThresholdsSchema,
  type AllowlistCreate,
  type AllowlistUpdate,
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
    | "unauthorized";
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

async function readError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error ?? body.message;
  } catch {
    return undefined;
  }
}

const STATUS_CODE = {
  400: { code: "bad_request" as const, fallback: "請求格式錯誤" },
  401: { code: "unauthorized" as const, fallback: "未登入" },
  403: { code: "forbidden" as const, fallback: "權限不足" },
  404: { code: "not_found" as const, fallback: "查無資料" },
  409: { code: "conflict" as const, fallback: "狀態衝突" },
} as const;

function statusErr(status: number, message: string | undefined): AdminApiErr {
  const mapped = STATUS_CODE[status as keyof typeof STATUS_CODE];
  if (mapped) {
    return { ok: false, status, code: mapped.code, message: message ?? mapped.fallback };
  }
  return {
    ok: false,
    status,
    code: "backend_unreachable",
    message: message ?? "後端無法連線，請稍後再試",
  };
}

const UNREACHABLE: AdminApiErr = {
  ok: false,
  status: 0,
  code: "backend_unreachable",
  message: "後端無法連線，請稍後再試",
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
  if (!res.ok) return statusErr(res.status, await readError(res));
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

/**
 * 管理面 HTTP 客戶端：路徑與 schema 取自 contracts/browser。
 * 不含待審核准／退回（A 組批次 4 尚未合併）。fetch 可注入以便測試。
 */
export function createAdminApi(opts: { fetch?: FetchLike; baseUrl?: string } = {}) {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? adminApiBaseUrl();
  const url = (path: string, params?: Record<string, string>) =>
    joinUrl(base, params ? fillPath(path, params) : path);

  const jsonInit = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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
    async listPending() {
      const r = await request(fetchImpl, url(ADMIN_API_PATHS.blacklistPending), { method: "GET" });
      if (!r.ok) return r;
      const parsed = parse(PendingCandidateListSchema, r.body);
      return parsed.ok ? { ok: true as const, value: parsed.value.items } : parsed;
    },
    async listBlacklist() {
      const r = await request(fetchImpl, url(ADMIN_API_PATHS.blacklist), { method: "GET" });
      if (!r.ok) return r;
      const parsed = parse(BlocklistListSchema, r.body);
      return parsed.ok ? { ok: true as const, value: parsed.value.items } : parsed;
    },
    async revokeBlacklist(entryId: string) {
      const r = await request(
        fetchImpl,
        url(ADMIN_API_PATHS.blacklistRevoke, { entryId }),
        jsonInit("POST"),
      );
      if (!r.ok) return r;
      return parse(BlocklistEntrySchema, r.body);
    },
    async listWhitelist() {
      const r = await request(fetchImpl, url(ADMIN_API_PATHS.whitelist), { method: "GET" });
      if (!r.ok) return r;
      const parsed = parse(AllowlistListSchema, r.body);
      return parsed.ok ? { ok: true as const, value: parsed.value.items } : parsed;
    },
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
