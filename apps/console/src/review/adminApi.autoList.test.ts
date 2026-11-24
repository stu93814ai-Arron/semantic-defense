import { describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts/browser";
import { createAdminApi, type FetchLike } from "./adminApi";
import { resetReviewSource, reviewSource } from "./reviewSource";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Seen = { url: string; method: string; body: unknown; cred?: RequestCredentials };

function recorder(reply: (seen: Seen) => Response): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const s: Seen = {
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        cred: init?.credentials,
      };
      seen.push(s);
      return reply(s);
    },
  };
}

// 中性 fixture：不抄寫後端實際字串，只驗證原樣傳遞。
const BACKEND_409 = "backend-409-message-fixture";
const BACKEND_403 = "backend-403-message-fixture";
const BACKEND_401 = "backend-401-message-fixture";

describe("adminApi 自動上榜開關（/api/settings/auto-list）", () => {
  it("GET 走契約路徑並以 AutoListSettingSchema 解析", async () => {
    const r0 = recorder(() => jsonResponse(200, { enabled: false }));
    const r = await createAdminApi({ fetch: r0.fetch }).getAutoList();
    expect(r).toEqual({ ok: true, value: { enabled: false } });
    expect(r0.seen).toEqual([
      { url: ADMIN_API_PATHS.autoList, method: "GET", body: undefined, cred: "include" },
    ]);
  });

  it("GET 回應多欄或非布林 → invalid_response（strict）", async () => {
    for (const body of [{ enabled: true, extra: 1 }, { enabled: "true" }, {}]) {
      const r = await createAdminApi({ fetch: async () => jsonResponse(200, body) }).getAutoList();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_response");
    }
  });

  it("PUT 送 { enabled } 並解析回應", async () => {
    const r0 = recorder((s) => jsonResponse(200, s.body));
    const r = await createAdminApi({ fetch: r0.fetch }).putAutoList({ enabled: false });
    expect(r).toEqual({ ok: true, value: { enabled: false } });
    expect(r0.seen).toEqual([
      { url: ADMIN_API_PATHS.autoList, method: "PUT", body: { enabled: false }, cred: "include" },
    ]);
  });

  it("409 → conflict，訊息取後端字串", async () => {
    const r = await createAdminApi({
      fetch: async () => jsonResponse(409, { error: BACKEND_409 }),
    }).putAutoList({ enabled: true });
    expect(r).toMatchObject({ ok: false, status: 409, code: "conflict", message: BACKEND_409 });
  });

  it("403、401 照後端字串原樣傳遞；超長截斷至 200 字", async () => {
    const forb = await createAdminApi({
      fetch: async () => jsonResponse(403, { error: BACKEND_403 }),
    }).putAutoList({ enabled: false });
    expect(forb).toMatchObject({ ok: false, code: "forbidden", message: BACKEND_403 });
    const unauth = await createAdminApi({
      fetch: async () => jsonResponse(401, { error: BACKEND_401 }),
    }).getAutoList();
    expect(unauth).toMatchObject({ ok: false, code: "unauthorized", message: BACKEND_401 });
    const long = await createAdminApi({
      fetch: async () => jsonResponse(409, { error: "長".repeat(500) }),
    }).putAutoList({ enabled: true });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toHaveLength(200);
  });

  it("5xx 一律固定前端文案，不帶後端字串", async () => {
    const r = await createAdminApi({
      fetch: async () => jsonResponse(500, { error: "backend-500-message-fixture" }),
    }).getAutoList();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("backend_unreachable");
      expect(r.message).not.toMatch(/fixture/);
    }
  });
});

describe("reviewSource 自動上榜開關：直通 API，不回退 demo", () => {
  it("404 時即使 VITE_DEMO_FALLBACK=1 也回錯誤，不給示範值", async () => {
    resetReviewSource(
      createAdminApi({ fetch: async () => jsonResponse(404, { error: "Not Found" }) }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    const g = await reviewSource.getAutoList();
    expect(g.ok).toBe(false);
    const p = await reviewSource.putAutoList({ enabled: false });
    expect(p.ok).toBe(false);
    resetReviewSource();
  });

  it("成功時回傳 API 值", async () => {
    resetReviewSource(createAdminApi({ fetch: async () => jsonResponse(200, { enabled: true }) }));
    expect(await reviewSource.getAutoList()).toEqual({ ok: true, value: { enabled: true } });
    resetReviewSource();
  });
});
