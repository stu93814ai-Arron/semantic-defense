import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS, AllowlistEntrySchema, AllowlistListSchema } from "@semantic-defense/contracts";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

/** ③a 白名單 CRUD：僅 platform_admin；每筆寫入與稽核同一 tx。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const NOW = Date.parse("2026-11-09T00:00:00Z");
const LIST = ADMIN_API_PATHS.whitelist;
const one = (id: string) => ADMIN_API_PATHS.whitelistEntry.replace(":entryId", id);
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const C = { cidr: "10.0.0.0/8", reason: "辦公室出口", expires_at: null };

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
const admin = () => as("admin1", "pass-admin-1");
type M = "GET" | "POST" | "PATCH" | "DELETE";
const req = (c: string | undefined, method: M, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: c ? cookieHeader(c) : {}, payload: payload as object });
const audits = async () =>
  (await app.db.query<{ action: string; actor: string; detail: Record<string, unknown> }>(
    "SELECT action, actor, detail FROM audit_events WHERE action LIKE 'whitelist.%' ORDER BY id")).rows;

describe("白名單 CRUD（platform_admin）", () => {
  it("新增 201 → 列表可見（符合契約）→ 修改 200 → 刪除 204；每步一筆稽核", async () => {
    await boot();
    const c = await admin();
    const r = await req(c, "POST", LIST, C);
    expect(r.statusCode).toBe(201);
    const e = r.json() as { entry_id: string };
    expect(AllowlistEntrySchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ ...C, created_by: "admin1", created_at: new Date(NOW).toISOString() });
    const list = (await req(c, "GET", LIST)).json();
    expect(AllowlistListSchema.safeParse(list).success).toBe(true);
    expect(list).toEqual({ items: [e] });
    const exp = "2026-11-10T00:00:00.000Z";
    const u = await req(c, "PATCH", one(e.entry_id), { reason: "改理由", expires_at: exp });
    expect(u.statusCode).toBe(200);
    expect(u.json()).toEqual({ ...e, reason: "改理由", expires_at: exp });
    expect((await req(c, "DELETE", one(e.entry_id))).statusCode).toBe(204);
    expect((await req(c, "GET", LIST)).json()).toEqual({ items: [] });
    expect((await audits()).map((a) => [a.action, a.actor, a.detail.entry_id])).toEqual([
      ["whitelist.create", "admin1", e.entry_id], ["whitelist.update", "admin1", e.entry_id], ["whitelist.delete", "admin1", e.entry_id],
    ]);
  });

  it("非法本文 → 400；不存在 → 404；皆不寫稽核", async () => {
    await boot();
    const c = await admin();
    for (const bad of [undefined, {}, { ...C, cidr: "10.0.0.1/8" }, { ...C, cidr: "127.0.0.0/8" }, { ...C, extra: 1 },
      { ...C, entry_id: UNKNOWN }, { ...C, expires_at: "2026-11-08T00:00:00Z" }, { ...C, reason: "" }]) {
      expect((await req(c, "POST", LIST, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const { entry_id } = (await req(c, "POST", LIST, C)).json() as { entry_id: string };
    for (const bad of [{ reason: "r" }, { reason: "r", expires_at: null, cidr: "10.0.0.0/8" }, { reason: "r", expires_at: "2026-11-01T00:00:00Z" }]) {
      expect((await req(c, "PATCH", one(entry_id), bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await req(c, "PATCH", one(UNKNOWN), { reason: "r", expires_at: null })).statusCode).toBe(404);
    expect((await req(c, "DELETE", one(UNKNOWN))).statusCode).toBe(404);
    expect((await req(c, "DELETE", one("not-a-uuid"))).statusCode).toBe(404);
    expect((await audits()).map((a) => a.action)).toEqual(["whitelist.create"]);
  });

  it("operator、app_owner 讀寫皆 403；匿名 401；不寫稽核", async () => {
    await boot();
    const { entry_id } = (await req(await admin(), "POST", LIST, C)).json() as { entry_id: string };
    for (const [u, p] of [["operator1", "pass-operator-1"], ["owner1", "pass-owner-1"]] as const) {
      const c = await as(u, p);
      expect((await req(c, "GET", LIST)).statusCode, u).toBe(403);
      expect((await req(c, "POST", LIST, C)).statusCode, u).toBe(403);
      expect((await req(c, "PATCH", one(entry_id), { reason: "x", expires_at: null })).statusCode, u).toBe(403);
      expect((await req(c, "DELETE", one(entry_id))).statusCode, u).toBe(403);
    }
    expect((await req(undefined, "POST", LIST, C)).statusCode).toBe(401);
    expect((await req(undefined, "DELETE", one(entry_id))).statusCode).toBe(401);
    expect((await audits()).map((a) => a.action)).toEqual(["whitelist.create"]);
  });

  it("稽核寫入失敗 → 500，資料不變（同一 tx）", async () => {
    await boot();
    const c = await admin();
    const { entry_id } = (await req(c, "POST", LIST, C)).json() as { entry_id: string };
    await app.db.exec("ALTER TABLE audit_events ADD CONSTRAINT t_no_wl CHECK (action NOT LIKE 'whitelist.%') NOT VALID");
    try {
      expect((await req(c, "POST", LIST, { ...C, cidr: "192.168.0.0/16" })).statusCode).toBe(500);
      expect((await req(c, "PATCH", one(entry_id), { reason: "x", expires_at: null })).statusCode).toBe(500);
      expect((await req(c, "DELETE", one(entry_id))).statusCode).toBe(500);
    } finally {
      await app.db.exec("ALTER TABLE audit_events DROP CONSTRAINT t_no_wl");
    }
    const items = ((await req(c, "GET", LIST)).json() as { items: { entry_id: string; reason: string }[] }).items;
    expect(items.map((x) => [x.entry_id, x.reason])).toEqual([[entry_id, C.reason]]);
  });
});

describe("白名單 reason 控制字元", () => {
  it("reason 含 \\u0000 或 bidi 控制字元 → 400（不是 500）；不寫入、不寫稽核", async () => {
    await boot();
    const c = await admin();
    for (const reason of ["a\u0000b", "a\u202eb", "a\nb"]) {
      expect((await req(c, "POST", LIST, { ...C, reason })).statusCode, JSON.stringify(reason)).toBe(400);
    }
    const { entry_id } = (await req(c, "POST", LIST, C)).json() as { entry_id: string };
    expect((await req(c, "PATCH", one(entry_id), { reason: "x\u0000", expires_at: null })).statusCode).toBe(400);
    expect(((await req(c, "GET", LIST)).json() as { items: { reason: string }[] }).items.map((x) => x.reason)).toEqual([C.reason]);
    expect((await audits()).map((a) => a.action)).toEqual(["whitelist.create"]);
  });
});
