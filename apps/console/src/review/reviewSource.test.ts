import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts/browser";
import { createAdminApi, type FetchLike } from "./adminApi";
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
    expect(items.map((i) => i.cidr)).toEqual(["203.0.113.0/24"]);
  });
});

describe("reviewSource：管理面 404 時回退 demoStore（e2e 無後端）", () => {
  it("GET 白名單 404 後改走 demo，新增仍寫入 demo", async () => {
    resetReviewSource(
      createAdminApi({
        fetch: async () => json(404, { error: "Not Found" }),
      }),
    );
    expect(await reviewSource.listWhitelist()).toEqual([]);
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

describe("reviewSource：核准／退回仍走 demoStore", () => {
  it("不呼叫 approve／reject 路徑", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      urls.push(String(input));
      return json(404, { error: "Not Found" });
    };
    resetReviewSource(createAdminApi({ fetch: fetchImpl }));
    const r = await reviewSource.approve("11111111-1111-4111-8111-111111111111", "operator1");
    expect(r.ok).toBe(true);
    expect(urls.some((u) => u.includes("approve") || u.includes("reject"))).toBe(false);
    expect(listPending().some((p) => p.case_id.startsWith("11111111"))).toBe(false);
  });
});
