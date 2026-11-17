import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts/browser";
import { createAdminApi } from "./adminApi";
import {
  listAllowlist,
  listPending,
  resetDemoStoreForTests,
  seedFixturesForTests,
} from "./demoStore";
import { resetReviewSource, reviewSource } from "./reviewSource";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ALLOW = {
  entry_id: "33333333-3333-4333-8333-333333333333",
  cidr: "203.0.113.0/24",
  reason: "夥伴",
  created_by: "admin1",
  created_at: "2026-11-05T00:00:00Z",
  expires_at: null,
};

beforeEach(() => {
  seedFixturesForTests();
});
afterEach(() => {
  resetDemoStoreForTests();
  resetReviewSource();
});

describe("reviewSource：API 成功時用契約資料", () => {
  it("listWhitelist 回 API items，不走空的 demo 列表", async () => {
    resetReviewSource(
      createAdminApi({
        fetch: async (input) => {
          if (String(input).endsWith(ADMIN_API_PATHS.whitelist)) {
            return json(200, { items: [ALLOW] });
          }
          return json(404, { error: "Not Found" });
        },
      }),
    );
    const items = await reviewSource.listWhitelist();
    expect(items.ok).toBe(true);
    if (items.ok) expect(items.value.map((i) => i.cidr)).toEqual(["203.0.113.0/24"]);
  });
});

describe("reviewSource：管理面 404 時回退 demoStore（e2e 無後端）", () => {
  it("GET 白名單 404 後改走 demo，新增仍寫入 demo", async () => {
    resetReviewSource(
      createAdminApi({
        fetch: async () => json(404, { error: "Not Found" }),
      }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    const listed = await reviewSource.listWhitelist();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toEqual([]);
    const added = await reviewSource.createWhitelist(
      { cidr: "203.0.113.0/24", reason: "夥伴出口", expires_at: null },
      "admin1",
    );
    expect(added.ok).toBe(true);
    expect(listAllowlist().some((i) => i.reason === "夥伴出口")).toBe(true);
  });
});

describe("reviewSource：網路失敗設 backend unreachable", () => {
  it("getThresholds 失敗時標示不可達", async () => {
    resetReviewSource(
      createAdminApi({
        fetch: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    );
    const r = await reviewSource.getThresholds();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("backend_unreachable");
    expect(reviewSource.isUnreachable()).toBe(true);
  });
});

const PENDING_CASE = "11111111-1111-4111-8111-111111111111";
const APPROVED_ENTRY = {
  entry_id: "22222222-2222-4222-8222-222222222222",
  ip: "203.0.113.10",
  source: "manual" as const,
  confidence: 0.55,
  case_id: PENDING_CASE,
  created_at: "2026-11-05T00:00:00Z",
  expires_at: "2026-11-06T01:00:00Z",
  approved_by: "operator1",
  approved_at: "2026-11-05T01:00:00Z",
  revoked_at: null,
};

describe("reviewSource：核准／退回呼叫真實 API", () => {
  it("核准 POST 無本文，回 BlocklistEntry，不寫入 demo", async () => {
    const seen: { url: string; method?: string; body?: BodyInit | null }[] = [];
    resetReviewSource(
      createAdminApi({
        fetch: async (input, init) => {
          seen.push({ url: String(input), method: init?.method, body: init?.body });
          return json(200, APPROVED_ENTRY);
        },
      }),
    );
    const r = await reviewSource.approve(PENDING_CASE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(APPROVED_ENTRY);
    expect(seen).toEqual([
      { url: `${ADMIN_API_PATHS.blacklistPending}/${PENDING_CASE}/approve`, method: "POST", body: undefined },
    ]);
    expect(listPending().some((p) => p.case_id === PENDING_CASE)).toBe(true);
  });

  it("退回 POST 無本文與理由欄，成功為 204", async () => {
    const seen: { url: string; method?: string; body?: BodyInit | null }[] = [];
    resetReviewSource(
      createAdminApi({
        fetch: async (input, init) => {
          seen.push({ url: String(input), method: init?.method, body: init?.body });
          return new Response(null, { status: 204 });
        },
      }),
    );
    const r = await reviewSource.reject(PENDING_CASE);
    expect(r.ok).toBe(true);
    expect(seen).toEqual([
      { url: `${ADMIN_API_PATHS.blacklistPending}/${PENDING_CASE}/reject`, method: "POST", body: undefined },
    ]);
    expect(listPending().some((p) => p.case_id === PENDING_CASE)).toBe(true);
  });

});

describe("reviewSource：核准／退回錯誤不回退 demo", () => {
    it("寫入 404 即使 VITE_DEMO_FALLBACK=1 也不回退，顯示後端訊息", async () => {
    resetReviewSource(
      createAdminApi({
        fetch: async () => json(404, { error: "查無待審案件" }),
      }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    const before = listPending().map((p) => p.case_id);
    const r = await reviewSource.approve(PENDING_CASE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("not_found");
      expect(r.message).toBe("查無待審案件");
    }
    expect(listPending().map((p) => p.case_id)).toEqual(before);
  });

  it("讀取已回退 demo 後，核准仍打 API，不把 404 當成功", async () => {
    const urls: string[] = [];
    resetReviewSource(
      createAdminApi({
        fetch: async (input) => {
          urls.push(String(input));
          return json(404, { error: "查無待審案件" });
        },
      }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    const listed = await reviewSource.listPending();
    expect(listed.ok).toBe(true);
    const r = await reviewSource.reject(PENDING_CASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("查無待審案件");
    expect(urls.some((u) => u.endsWith(`/${PENDING_CASE}/reject`))).toBe(true);
    expect(listPending().some((p) => p.case_id === PENDING_CASE)).toBe(true);
  });

  it("409 原樣回傳後端訊息，5xx 標示無法連線且不寫 demo", async () => {
    resetReviewSource(
      createAdminApi({
        fetch: async () => json(409, { error: "已在白名單" }),
      }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    const conflict = await reviewSource.approve(PENDING_CASE);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.status).toBe(409);
      expect(conflict.message).toBe("已在白名單");
    }
    expect(listPending().some((p) => p.case_id === PENDING_CASE)).toBe(true);

    resetReviewSource(
      createAdminApi({
        fetch: async () => json(503, { error: "暫時無法服務" }),
      }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    const down = await reviewSource.reject(PENDING_CASE);
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.code).toBe("backend_unreachable");
    expect(reviewSource.isUnreachable()).toBe(true);
  });
});

describe("reviewSource：VITE_DEMO_FALLBACK 與錯誤不回退", () => {
  it("flag 關閉時 404 回錯誤，不寫入 demo", async () => {
    resetReviewSource(
      createAdminApi({ fetch: async () => json(404, { error: "Not Found" }) }),
      { VITE_DEMO_FALLBACK: "" },
    );
    const listed = await reviewSource.listWhitelist();
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe("not_found");
    const added = await reviewSource.createWhitelist(
      { cidr: "203.0.113.0/24", reason: "夥伴出口", expires_at: null },
      "admin1",
    );
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.code).toBe("not_found");
    expect(listAllowlist().some((i) => i.reason === "夥伴出口")).toBe(false);
  });

  it("flag=1 且 404 時讀寫回退 demoStore", async () => {
    resetReviewSource(
      createAdminApi({ fetch: async () => json(404, { error: "Not Found" }) }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    const listed = await reviewSource.listWhitelist();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toEqual([]);
    const added = await reviewSource.createWhitelist(
      { cidr: "203.0.113.0/24", reason: "夥伴出口", expires_at: null },
      "admin1",
    );
    expect(added.ok).toBe(true);
    expect(listAllowlist().some((i) => i.reason === "夥伴出口")).toBe(true);
  });

  it("403 與 5xx 無論 flag 都不回退 demo", async () => {
    for (const flag of ["", "1"]) {
      resetDemoStoreForTests();
      seedFixturesForTests();
      resetReviewSource(
        createAdminApi({ fetch: async () => json(403, { error: "權限不足" }) }),
        { VITE_DEMO_FALLBACK: flag },
      );
      const forbidden = await reviewSource.listWhitelist();
      expect(forbidden.ok, `403 flag=${flag}`).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("forbidden");
      const write403 = await reviewSource.createWhitelist(
        { cidr: "203.0.113.0/24", reason: "不該寫入", expires_at: null },
        "admin1",
      );
      expect(write403.ok).toBe(false);
      expect(listAllowlist().some((i) => i.reason === "不該寫入")).toBe(false);

      resetReviewSource(
        createAdminApi({ fetch: async () => json(503, { error: "暫時無法服務" }) }),
        { VITE_DEMO_FALLBACK: flag },
      );
      const down = await reviewSource.listPending();
      expect(down.ok, `5xx flag=${flag}`).toBe(false);
      if (!down.ok) expect(down.code).toBe("backend_unreachable");
      expect(reviewSource.isUnreachable()).toBe(true);
    }
  });

  it("以靜態屬性讀取 VITE_DEMO_FALLBACK，供 Vite 注入 dev／e2e 旗標", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "reviewSource.ts"),
      "utf8",
    );
    expect(src).toMatch(/import\.meta\.env\.VITE_DEMO_FALLBACK/);
  });
});

describe("reviewSource：示範資料模式", () => {
  it("API 成功時 isDemo 為 false，即使旗標開啟", async () => {
    resetReviewSource(
      createAdminApi({
        fetch: async (input) => {
          if (String(input).endsWith(ADMIN_API_PATHS.whitelist)) {
            return json(200, { items: [ALLOW] });
          }
          return json(404, { error: "Not Found" });
        },
      }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    const items = await reviewSource.listWhitelist();
    expect(items.ok).toBe(true);
    expect(reviewSource.isDemo()).toBe(false);
  });

  it("VITE_DEMO_FALLBACK=1 且 404 回退後 isDemo 為 true", async () => {
    resetReviewSource(
      createAdminApi({ fetch: async () => json(404, { error: "Not Found" }) }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    expect(reviewSource.isDemo()).toBe(false);
    const listed = await reviewSource.listPending();
    expect(listed.ok).toBe(true);
    expect(reviewSource.isDemo()).toBe(true);
  });

  it("403 或旗標關閉的 404 都不進入示範模式", async () => {
    resetReviewSource(
      createAdminApi({ fetch: async () => json(403, { error: "權限不足" }) }),
      { VITE_DEMO_FALLBACK: "1" },
    );
    await reviewSource.listPending();
    expect(reviewSource.isDemo()).toBe(false);

    resetReviewSource(
      createAdminApi({ fetch: async () => json(404, { error: "Not Found" }) }),
      { VITE_DEMO_FALLBACK: "" },
    );
    await reviewSource.listPending();
    expect(reviewSource.isDemo()).toBe(false);
  });
});
