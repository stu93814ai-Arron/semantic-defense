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
