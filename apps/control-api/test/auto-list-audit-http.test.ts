import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { writeAutoBlocklistEntry } from "./helpers/auto-list.js";

/** (c) 自動上榜告警：沿用 blacklist.auto_list，經 GET /api/audit 可讀；非 platform_admin 為 403。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const NOW = Date.parse("2026-11-09T00:00:00Z");

async function boot(): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW });
  await seedPhase2Fixtures(app);
  return app;
}
async function as(username: string, password: string): Promise<string> {
  const r = await login(app, { username, password });
  expect(r.status).toBe(200);
  return r.cookie!;
}
const auditGet = (c: string | undefined) =>
  app.inject({ method: "GET", url: "/api/audit", headers: c ? cookieHeader(c) : {} });

describe("GET /api/audit 可見 blacklist.auto_list", () => {
  it("自動上榜後 platform_admin 讀得到正確欄位；operator、app_owner 為 403", async () => {
    await boot();
    const input = { ip: "64.0.113.7", confidence: 0.95, case_id: randomUUID() };
    const listed = await writeAutoBlocklistEntry(app.db, input, NOW);
    expect(listed.status).toBe("listed");
    if (listed.status !== "listed") return;
    const admin = await auditGet(await as("admin1", "pass-admin-1"));
    expect(admin.statusCode).toBe(200);
    const items = (admin.json() as { items: Array<{ action: string; actor: string; sensor_id: string | null; at: number; detail: Record<string, unknown> }> }).items;
    const row = items.find((x) => x.action === "blacklist.auto_list");
    expect(row).toEqual({
      action: "blacklist.auto_list",
      actor: "system:auto",
      sensor_id: null,
      at: NOW,
      detail: {
        entry_id: listed.entry.entry_id,
        ip: "64.0.113.7/32",
        confidence: 0.95,
        case_id: input.case_id,
        expires_at: listed.entry.expires_at,
      },
    });
    for (const [u, p] of [["operator1", "pass-operator-1"], ["owner1", "pass-owner-1"]] as const) {
      expect((await auditGet(await as(u, p))).statusCode, u).toBe(403);
    }
  });
});
