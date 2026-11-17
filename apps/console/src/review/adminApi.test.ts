import { describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts/browser";
import { adminApiBaseUrl, createAdminApi, fillPath, type FetchLike } from "./adminApi";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TH = { case: 0.5, auto: 0.9 };
const PENDING = {
  ip: "203.0.113.10",
  confidence: 0.55,
  case_id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-11-05T00:00:00Z",
  hit_count: 2,
  last_hit_at: "2026-11-05T01:00:00Z",
};
const LISTED = {
  entry_id: "22222222-2222-4222-8222-222222222222",
  ip: "203.0.113.10",
  source: "manual" as const,
  confidence: 0.55,
  case_id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-11-05T00:00:00Z",
  expires_at: "2026-11-06T01:00:00Z",
  approved_by: "operator1",
  approved_at: "2026-11-05T01:00:00Z",
  revoked_at: null,
};
const ALLOW = {
  entry_id: "33333333-3333-4333-8333-333333333333",
  cidr: "203.0.113.0/24",
  reason: "夥伴",
  created_by: "admin1",
  created_at: "2026-11-05T00:00:00Z",
  expires_at: null,
};

function getBody(url: string): unknown | undefined {
  if (url === ADMIN_API_PATHS.thresholds) return TH;
  if (url === ADMIN_API_PATHS.blacklistPending) return { items: [PENDING] };
  if (url === ADMIN_API_PATHS.blacklist) return { items: [LISTED] };
  if (url === ADMIN_API_PATHS.whitelist) return { items: [ALLOW] };
  return undefined;
}

function mapFetch(handlers: Map<string, (init?: RequestInit) => Response>): FetchLike {
  return async (input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const h = handlers.get(key) ?? handlers.get(String(input));
    return h ? h(init) : jsonResponse(404, { error: "Not Found" });
  };
}

describe("adminApi 路徑與 base URL", () => {
  it("預設 base 為空字串（同源 /api）", () => {
    expect(adminApiBaseUrl({})).toBe("");
    expect(adminApiBaseUrl({ VITE_ADMIN_API_BASE: "http://127.0.0.1:3000/" })).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("fillPath 代入 ADMIN_API_PATHS 參數", () => {
    expect(fillPath(ADMIN_API_PATHS.whitelistEntry, { entryId: "abc" })).toBe(
      "/api/whitelist/abc",
    );
    expect(fillPath(ADMIN_API_PATHS.blacklistRevoke, { entryId: "e1" })).toBe(
      "/api/blacklist/e1/revoke",
    );
    expect(fillPath(ADMIN_API_PATHS.blacklistPendingApprove, { caseId: PENDING.case_id })).toBe(
      `/api/blacklist/pending/${PENDING.case_id}/approve`,
    );
    expect(fillPath(ADMIN_API_PATHS.blacklistPendingReject, { caseId: PENDING.case_id })).toBe(
      `/api/blacklist/pending/${PENDING.case_id}/reject`,
    );
  });
});

describe("adminApi GET 解析契約 schema", () => {
  it("門檻本體與列表 items；待審含 hit_count／last_hit_at", async () => {
    const calls: string[] = [];
    const api = createAdminApi({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        const body = getBody(url);
        return body === undefined
          ? jsonResponse(404, { error: "Not Found" })
          : jsonResponse(200, body);
      },
    });
    const t = await api.getThresholds();
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.value).toEqual(TH);
    const p = await api.listPending();
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value[0]!.hit_count).toBe(2);
      expect(p.value[0]!.last_hit_at).toBe("2026-11-05T01:00:00Z");
    }
    expect((await api.listBlacklist()).ok).toBe(true);
    expect((await api.listWhitelist()).ok).toBe(true);
    expect(calls.some((c) => c.includes("approve") || c.includes("reject"))).toBe(false);
  });
});

describe("adminApi 寫入路徑", () => {
  it("PUT／POST／PATCH／DELETE 與撤回帶 credentials", async () => {
    const seen: { method: string; cred?: RequestCredentials }[] = [];
    const handlers = new Map<string, (init?: RequestInit) => Response>([
      ["PUT " + ADMIN_API_PATHS.thresholds, () => jsonResponse(200, TH)],
      ["POST " + ADMIN_API_PATHS.whitelist, () => jsonResponse(201, ALLOW)],
      ["PATCH /api/whitelist/" + ALLOW.entry_id, () =>
        jsonResponse(200, { ...ALLOW, reason: "更新" })],
      ["DELETE /api/whitelist/" + ALLOW.entry_id, () => new Response(null, { status: 204 })],
      ["POST /api/blacklist/" + LISTED.entry_id + "/revoke", () =>
        jsonResponse(200, { ...LISTED, revoked_at: "2026-11-05T02:00:00Z" })],
    ]);
    const client = createAdminApi({
      fetch: async (input, init) => {
        seen.push({ method: String(init?.method ?? "GET"), cred: init?.credentials });
        return mapFetch(handlers)(input, init);
      },
    });
    expect((await client.putThresholds(TH)).ok).toBe(true);
    expect((await client.createWhitelist({ cidr: ALLOW.cidr, reason: "夥伴", expires_at: null })).ok).toBe(true);
    const up = await client.updateWhitelist(ALLOW.entry_id, { reason: "更新", expires_at: null });
    expect(up.ok).toBe(true);
    if (up.ok) expect(up.value.reason).toBe("更新");
    expect((await client.deleteWhitelist(ALLOW.entry_id)).ok).toBe(true);
    const rev = await client.revokeBlacklist(LISTED.entry_id);
    expect(rev.ok).toBe(true);
    if (rev.ok) expect(rev.value.revoked_at).toBe("2026-11-05T02:00:00Z");
    expect(seen.every((s) => s.cred === "include")).toBe(true);
    expect(seen.map((s) => s.method)).toEqual(["PUT", "POST", "PATCH", "DELETE", "POST"]);
  });
});

describe("adminApi 錯誤", () => {
  it("403 → forbidden", async () => {
    const r = await createAdminApi({
      fetch: async () => jsonResponse(403, { error: "權限不足" }),
    }).listWhitelist();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("forbidden");
      expect(r.status).toBe(403);
      expect(r.message).toMatch(/權限/);
    }
  });

  it("409 → conflict", async () => {
    const r = await createAdminApi({
      fetch: async () => jsonResponse(409, { error: "已撤回" }),
    }).revokeBlacklist(LISTED.entry_id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("conflict");
      expect(r.status).toBe(409);
      expect(r.message).toMatch(/已撤回/);
    }
  });

  it("網路失敗 → backend_unreachable", async () => {
    const r = await createAdminApi({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    }).getThresholds();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("backend_unreachable");
      expect(r.status).toBe(0);
      expect(r.message).toMatch(/後端無法連線/);
    }
  });

  it("不符 schema → invalid_response", async () => {
    const r = await createAdminApi({
      fetch: async () => jsonResponse(200, { items: [{ ip: "nope" }] }),
    }).listPending();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_response");
  });
});

describe("adminApi 待審核准與退回", () => {
  const approveUrl = `/api/blacklist/pending/${PENDING.case_id}/approve`;
  const rejectUrl = `/api/blacklist/pending/${PENDING.case_id}/reject`;

  it("核准 POST 無本文，回應為 BlocklistEntry", async () => {
    const seen: { url: string; method?: string; body?: BodyInit | null; type?: string | null }[] = [];
    const api = createAdminApi({
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(input),
          method: init?.method,
          body: init?.body,
          type: headers.get("Content-Type"),
        });
        return jsonResponse(200, LISTED);
      },
    });
    const r = await api.approvePending(PENDING.case_id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(LISTED);
    expect(seen).toEqual([
      { url: approveUrl, method: "POST", body: undefined, type: null },
    ]);
  });

  it("退回 POST 無本文，204 無本體", async () => {
    const seen: { url: string; method?: string; body?: BodyInit | null }[] = [];
    const api = createAdminApi({
      fetch: async (input, init) => {
        seen.push({ url: String(input), method: init?.method, body: init?.body });
        return new Response(null, { status: 204 });
      },
    });
    const r = await api.rejectPending(PENDING.case_id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
    expect(seen).toEqual([{ url: rejectUrl, method: "POST", body: undefined }]);
  });

  it("404 顯示後端訊息，不改寫成通用查無資料", async () => {
    const r = await createAdminApi({
      fetch: async () => jsonResponse(404, { error: "查無待審案件" }),
    }).approvePending(PENDING.case_id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.code).toBe("not_found");
      expect(r.message).toBe("查無待審案件");
    }
  });

  it("409 原樣顯示後端訊息", async () => {
    const r = await createAdminApi({
      fetch: async () => jsonResponse(409, { error: "已自動上榜" }),
    }).rejectPending(PENDING.case_id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.code).toBe("conflict");
      expect(r.message).toBe("已自動上榜");
    }
  });

  it("未知 4xx 顯示後端訊息，不視為無法連線", async () => {
    const r = await createAdminApi({
      fetch: async () => jsonResponse(429, { error: "已達每小時上限" }),
    }).approvePending(PENDING.case_id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(429);
      expect(r.code).toBe("client_error");
      expect(r.message).toBe("已達每小時上限");
      expect(r.code).not.toBe("backend_unreachable");
    }
  });
});

describe("adminApi 安全硬化", () => {
    it("核准與退回路徑把含特殊字元的 caseId 以 encodeURIComponent 編碼", async () => {
    const caseId = "id with/slash?and=query#hash";
    const encoded = encodeURIComponent(caseId);
    expect(encoded).not.toBe(caseId);
    const seen: string[] = [];
    const api = createAdminApi({
      fetch: async (input) => {
        seen.push(String(input));
        return new Response(null, { status: 204 });
      },
    });
    await api.approvePending(caseId);
    await api.rejectPending(caseId);
    expect(seen).toEqual([
      `/api/blacklist/pending/${encoded}/approve`,
      `/api/blacklist/pending/${encoded}/reject`,
    ]);
    expect(seen.some((u) => u.includes("slash?and"))).toBe(false);
    expect(fillPath(ADMIN_API_PATHS.blacklistPendingApprove, { caseId })).toBe(
      `/api/blacklist/pending/${encoded}/approve`,
    );
  });

  it("client_error 只接受字串 error，超過約 200 字截斷，非字串用預設文案", async () => {
    const call = (body: unknown) =>
      createAdminApi({
        fetch: async () => jsonResponse(429, body),
      }).approvePending(PENDING.case_id);

    const ok = await call({ error: "已達每小時上限" });
    expect(ok.ok).toBe(false);
    if (!ok.ok) {
      expect(ok.code).toBe("client_error");
      expect(ok.message).toBe("已達每小時上限");
    }

    const nonString = await call({ error: { code: "rate" } });
    expect(nonString.ok).toBe(false);
    if (!nonString.ok) expect(nonString.message).toBe("請求無法完成");

    const fromMessage = await call({ message: "不應採用 message 欄" });
    expect(fromMessage.ok).toBe(false);
    if (!fromMessage.ok) expect(fromMessage.message).toBe("請求無法完成");

    const long = "限".repeat(250);
    const truncated = await call({ error: long });
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) {
      expect(truncated.message).toBe("限".repeat(200));
      expect(truncated.message.length).toBe(200);
    }
  });

  it("5xx 一律顯示前端固定訊息，不採用後端本文", async () => {
    const r = await createAdminApi({
      fetch: async () => jsonResponse(500, { error: "internal secret stack" }),
    }).approvePending(PENDING.case_id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.code).toBe("backend_unreachable");
      expect(r.message).toBe("後端無法連線，請稍後再試");
      expect(r.message).not.toMatch(/secret|internal/);
    }
  });
});


describe("adminApi 對應 4xx 訊息截斷", () => {
  it("400／401／403／404／409 的後端字串訊息同樣截斷至約 200 字", async () => {
    const long = "錯".repeat(250);
    const cases = [
      { status: 400, code: "bad_request" },
      { status: 401, code: "unauthorized" },
      { status: 403, code: "forbidden" },
      { status: 404, code: "not_found" },
      { status: 409, code: "conflict" },
    ] as const;
    for (const { status, code } of cases) {
      const fromError = await createAdminApi({
        fetch: async () => jsonResponse(status, { error: long }),
      }).approvePending(PENDING.case_id);
      expect(fromError.ok).toBe(false);
      if (!fromError.ok) {
        expect(fromError.code).toBe(code);
        expect(fromError.message).toBe("錯".repeat(200));
        expect(fromError.message.length).toBe(200);
      }
      const fromMessage = await createAdminApi({
        fetch: async () => jsonResponse(status, { message: long }),
      }).approvePending(PENDING.case_id);
      expect(fromMessage.ok).toBe(false);
      if (!fromMessage.ok) {
        expect(fromMessage.message).toBe("錯".repeat(200));
        expect(fromMessage.message.length).toBe(200);
      }
    }
  });
});
