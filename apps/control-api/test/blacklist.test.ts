import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS, BlocklistEntrySchema, BlocklistListSchema } from "@semantic-defense/contracts";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

/** ③b 黑名單讀取／撤回：僅 operator（MONITOR §7a）；撤回與稽核同一 tx。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const CREATED = Date.parse("2026-11-09T00:00:00Z");
const NOW = CREATED + 60_000;
const revokeUrl = (id: string) => ADMIN_API_PATHS.blacklistRevoke.replace(":entryId", id);

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
const op = () => as("operator1", "pass-operator-1");
async function seedEntry(ip = "198.51.100.1"): Promise<string> {
  const id = randomUUID();
  await app.db.query(
    `INSERT INTO blocklist_entries (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at)
     VALUES ($1,$2,'auto',0.95,$3,$4,$5,'system:auto',$4,NULL)`,
    [id, ip, randomUUID(), CREATED, CREATED + 24 * 3600_000],
  );
  return id;
}
const get = (c?: string) => app.inject({ method: "GET", url: ADMIN_API_PATHS.blacklist, headers: c ? cookieHeader(c) : {} });
const revoke = (c: string | undefined, id: string) =>
  app.inject({ method: "POST", url: revokeUrl(id), headers: c ? cookieHeader(c) : {} });
const audits = async () =>
  (await app.db.query<{ action: string; actor: string; detail: Record<string, unknown> }>(
    "SELECT action, actor, detail FROM audit_events WHERE action LIKE 'blacklist.%' ORDER BY id")).rows;

describe("黑名單讀取／撤回（operator）", () => {
  it("GET 回 {items: 黑名單項目[]}（符合契約）", async () => {
    await boot();
    const id = await seedEntry();
    const r = await get(await op());
    expect(r.statusCode).toBe(200);
    expect(BlocklistListSchema.safeParse(r.json()).success).toBe(true);
    expect((r.json() as { items: { entry_id: string; revoked_at: null }[] }).items.map((x) => [x.entry_id, x.revoked_at])).toEqual([[id, null]]);
  });

  it("撤回 200 回更新後項目（revoked_at＝now）；寫一筆 blacklist.revoke；再撤回 409 不再寫稽核", async () => {
    await boot();
    const c = await op();
    const id = await seedEntry();
    const r = await revoke(c, id);
    expect(r.statusCode).toBe(200);
    expect(BlocklistEntrySchema.safeParse(r.json()).success).toBe(true);
    expect(r.json()).toMatchObject({ entry_id: id, revoked_at: new Date(NOW).toISOString() });
    expect((await revoke(c, id)).statusCode).toBe(409);
    expect((await audits()).map((a) => [a.action, a.actor, a.detail.entry_id])).toEqual([["blacklist.revoke", "operator1", id]]);
  });

  it("兩人同時撤回：只有一個 200、只留一筆稽核", async () => {
    await boot();
    const [a, b] = [await op(), await op()];
    const id = await seedEntry();
    const codes = (await Promise.all([revoke(a, id), revoke(b, id)])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(await audits()).toHaveLength(1);
  });

  it("不存在／非 uuid → 404，不寫稽核", async () => {
    await boot();
    const c = await op();
    expect((await revoke(c, randomUUID())).statusCode).toBe(404);
    expect((await revoke(c, "nope")).statusCode).toBe(404);
    expect(await audits()).toEqual([]);
  });

  it("platform_admin、app_owner 讀與撤回皆 403；匿名 401；項目不變", async () => {
    await boot();
    const id = await seedEntry();
    for (const [u, p] of [["admin1", "pass-admin-1"], ["owner1", "pass-owner-1"]] as const) {
      const c = await as(u, p);
      expect((await get(c)).statusCode, u).toBe(403);
      expect((await revoke(c, id)).statusCode, u).toBe(403);
    }
    expect((await get()).statusCode).toBe(401);
    expect((await revoke(undefined, id)).statusCode).toBe(401);
    const row = (await app.db.query<{ revoked_at: string | null }>("SELECT revoked_at FROM blocklist_entries WHERE entry_id = $1", [id])).rows[0]!;
    expect(row.revoked_at).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it("稽核寫入失敗 → 500，revoked_at 仍為 null（同一 tx）", async () => {
    await boot();
    const c = await op();
    const id = await seedEntry();
    await app.db.exec("ALTER TABLE audit_events ADD CONSTRAINT t_no_bl CHECK (action <> 'blacklist.revoke') NOT VALID");
    try {
      expect((await revoke(c, id)).statusCode).toBe(500);
    } finally {
      await app.db.exec("ALTER TABLE audit_events DROP CONSTRAINT t_no_bl");
    }
    const row = (await app.db.query<{ revoked_at: string | null }>("SELECT revoked_at FROM blocklist_entries WHERE entry_id = $1", [id])).rows[0]!;
    expect(row.revoked_at).toBeNull();
  });
});

describe("角色鎖：operator 不能改白名單、門檻", () => {
  it("operator 對白名單寫入、門檻寫入皆 403", async () => {
    await boot();
    const c = await op();
    const h = cookieHeader(c);
    const wl = ADMIN_API_PATHS.whitelist;
    expect((await app.inject({ method: "POST", url: wl, headers: h, payload: { cidr: "10.0.0.0/8", reason: "r", expires_at: null } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `${wl}/${randomUUID()}`, headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: ADMIN_API_PATHS.thresholds, headers: h, payload: { case: 0.1, auto: 0.2 } })).statusCode).toBe(403);
  });
});
