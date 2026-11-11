import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS, PendingCandidateListSchema } from "@semantic-defense/contracts";
import { CASE_TTL_MS } from "../src/cases.js";
import type { ControlApi } from "./helpers/app.js";
import { cookieHeader } from "./helpers/session.js";
import { PENDING_HOST, PENDING_NOW, bootPending, pendingOps } from "./helpers/pending.js";

/** 待審列表：只回 open 且尚未到期；欄位嚴格照 PendingCandidate。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const NOW = PENDING_NOW;
const HOST = PENDING_HOST;
const V6 = "2001:db9::1/128";

const boot = async (): Promise<ControlApi> => (app = await bootPending());
const { as, op, seedCase } = pendingOps(() => app);
const get = (c?: string) =>
  app.inject({ method: "GET", url: ADMIN_API_PATHS.blacklistPending, headers: c ? cookieHeader(c) : {} });

describe("GET /api/blacklist/pending", () => {
  it("只回 open 且尚未到期；欄位符合 PendingCandidate；已到期與終態不出現", async () => {
    await boot();
    const openA = await seedCase({ conf: 0.7, hits: 2, created: NOW - 120_000, lastHit: NOW - 30_000 });
    const openB = await seedCase({ ip: V6, conf: 0.9, hits: 1, created: NOW - 10_000, lastHit: NOW - 10_000 });
    await seedCase({ ip: "64.0.113.8/32", state: "open", created: NOW - CASE_TTL_MS }); // expires_at = NOW，不算尚未到期
    await seedCase({ ip: "64.0.113.9/32", state: "approved", resolvedBy: "operator1", resolvedAt: NOW - 1_000 });
    await seedCase({ ip: "64.0.113.10/32", state: "rejected", resolvedBy: "operator1", resolvedAt: NOW - 1_000 });
    await seedCase({ ip: "64.0.113.11/32", state: "auto_listed", resolvedBy: "system:auto", resolvedAt: NOW - 1_000 });
    await seedCase({ ip: "64.0.113.12/32", state: "expired", created: NOW - CASE_TTL_MS - 1, resolvedAt: NOW - 1 });

    const r = await get(await op());
    expect(r.statusCode).toBe(200);
    expect(PendingCandidateListSchema.safeParse(r.json()).success).toBe(true);
    expect(r.json()).toEqual({
      items: [
        {
          ip: HOST, confidence: 0.7, case_id: openA,
          created_at: new Date(NOW - 120_000).toISOString(), hit_count: 2,
          last_hit_at: new Date(NOW - 30_000).toISOString(),
        },
        {
          ip: V6, confidence: 0.9, case_id: openB,
          created_at: new Date(NOW - 10_000).toISOString(), hit_count: 1,
          last_hit_at: new Date(NOW - 10_000).toISOString(),
        },
      ],
    });
  });

  it("platform_admin、app_owner 403；匿名 401", async () => {
    await boot();
    await seedCase();
    for (const [u, p] of [["admin1", "pass-admin-1"], ["owner1", "pass-owner-1"]] as const) {
      expect((await get(await as(u, p))).statusCode, u).toBe(403);
    }
    expect((await get()).statusCode).toBe(401);
  });
});
