import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { insertFlowEvents } from "@semantic-defense/flow-store/testing";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts";
import type { ControlApi } from "./helpers/app.js";
import { bootWithPhase2, requireLoginCookie } from "./helpers/boot-fixtures.js";
import { cookieHeader } from "./helpers/session.js";
import { DAY, MIN, T0, bootJudgeApp, flowEvent } from "./helpers/judge.js";
import { runJudgeTick } from "../src/judge.js";
import {
  LOCK_TEST_TIMEOUT_MS, holdShareAndAutoLock, lockGuardedUrl, waitShareWaiter,
} from "./helpers/locks.js";

/** 新增白名單時，同一交易撤回被 CIDR 完全包含的生效封鎖（auto 與 manual）。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const NOW = T0;
const LIST = ADMIN_API_PATHS.whitelist;
const entryPath = (id: string) => ADMIN_API_PATHS.whitelistEntry.replace(":entryId", id);
const body = (cidr: string) => ({ cidr, reason: "office", expires_at: null });

async function boot(): Promise<ControlApi> {
  app = await bootWithPhase2(() => NOW);
  return app;
}
const cookie = (username: string, password: string) => requireLoginCookie(app, username, password);
const postWl = (c: string | undefined, cidr: string) =>
  app.inject({ method: "POST", url: LIST, headers: c ? cookieHeader(c) : {}, payload: body(cidr) });

async function putBlock(ip: string, source: "auto" | "manual", extra?: { revoked?: number; ended?: number }): Promise<string> {
  const id = randomUUID();
  const created = NOW - 60_000;
  await app.db.query(
    `INSERT INTO blocklist_entries
      (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at, ended_at)
     VALUES ($1,$2,$3,0.95,$4,$5,$6,$7,$5,$8,$9)`,
    [id, ip, source, randomUUID(), created, created + DAY,
      source === "auto" ? "system:auto" : "admin1", extra?.revoked ?? null, extra?.ended ?? null],
  );
  return id;
}
type BlRow = { entry_id: string; ip: string; source: string; revoked_at: string | null; ended_at: string | null };
const blocks = async () =>
  (await app.db.query<BlRow>(
    "SELECT entry_id, ip, source, revoked_at, ended_at FROM blocklist_entries ORDER BY ip")).rows;
const revokeAudits = async () =>
  (await app.db.query<{ action: string; actor: string; at: string; detail: Record<string, unknown> }>(
    "SELECT action, actor, at, detail FROM audit_events WHERE action = 'blacklist.revoke' ORDER BY id")).rows;

describe("POST /api/whitelist 自動撤回生效封鎖", () => {
  it("非 platform_admin → 403，黑名單不變", async () => {
    await boot();
    const id = await putBlock("64.0.113.7/32", "auto");
    for (const [u, p] of [["operator1", "pass-operator-1"], ["owner1", "pass-owner-1"]] as const) {
      expect((await postWl(await cookie(u, p), "64.0.113.0/24")).statusCode, u).toBe(403);
    }
    expect((await postWl(undefined, "64.0.113.0/24")).statusCode).toBe(401);
    const rows = await blocks();
    expect(rows).toEqual([{ entry_id: id, ip: "64.0.113.7/32", source: "auto", revoked_at: null, ended_at: null }]);
    expect(await revokeAudits()).toEqual([]);
  });

  it("稽核寫入失敗 → 500，白名單與撤回都回滾", async () => {
    await boot();
    const id = await putBlock("64.0.113.7/32", "manual");
    const c = await cookie("admin1", "pass-admin-1");
    await app.db.exec("ALTER TABLE audit_events ADD CONSTRAINT t_no_rev CHECK (action <> 'blacklist.revoke') NOT VALID");
    try {
      expect((await postWl(c, "64.0.113.0/24")).statusCode).toBe(500);
    } finally {
      await app.db.exec("ALTER TABLE audit_events DROP CONSTRAINT t_no_rev");
    }
    expect(((await app.inject({ method: "GET", url: LIST, headers: cookieHeader(c) })).json() as { items: unknown[] }).items).toEqual([]);
    expect((await blocks())[0]).toMatchObject({ entry_id: id, revoked_at: null, ended_at: null });
    expect(await revokeAudits()).toEqual([]);
  });

  it("同一交易撤回 auto 與 manual 生效列；稽核欄位正確；已撤回／已結束的不動", async () => {
    await boot();
    const autoId = await putBlock("64.0.113.7/32", "auto");
    const manId = await putBlock("64.0.113.8/32", "manual");
    const oldRev = NOW - 30_000;
    const keptRev = await putBlock("64.0.113.9/32", "auto", { revoked: oldRev, ended: oldRev });
    const keptEnd = await putBlock("64.0.113.10/32", "manual", { ended: oldRev });
    const c = await cookie("admin1", "pass-admin-1");
    const res = await postWl(c, "64.0.113.0/24");
    expect(res.statusCode).toBe(201);
    const allowId = (res.json() as { entry_id: string }).entry_id;
    const row = async (id: string) => (await blocks()).find((r) => r.entry_id === id);
    expect(await row(autoId)).toMatchObject({ revoked_at: String(NOW), ended_at: String(NOW) });
    expect(await row(manId)).toMatchObject({ revoked_at: String(NOW), ended_at: String(NOW) });
    expect(await row(keptRev)).toMatchObject({ revoked_at: String(oldRev), ended_at: String(oldRev) });
    expect(await row(keptEnd)).toMatchObject({ revoked_at: null, ended_at: String(oldRev) });
    const revokes = await revokeAudits();
    expect(revokes.map((a) => [a.action, a.actor, Number(a.at)])).toEqual([
      ["blacklist.revoke", "admin1", NOW], ["blacklist.revoke", "admin1", NOW],
    ]);
    expect(revokes.map((a) => a.detail).sort((x, y) => String(x.ip).localeCompare(String(y.ip)))).toEqual([
      { entry_id: autoId, ip: "64.0.113.7/32", source: "auto", case_id: expect.any(String), allowlist_entry_id: allowId },
      { entry_id: manId, ip: "64.0.113.8/32", source: "manual", case_id: expect.any(String), allowlist_entry_id: allowId },
    ]);
    const creates = (await app.db.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action = 'whitelist.create'")).rows;
    expect(creates).toHaveLength(1);
    expect(((await app.inject({ method: "GET", url: LIST, headers: cookieHeader(c) })).json() as { items: { entry_id: string }[] }).items
      .map((x) => x.entry_id)).toContain(allowId);
  });

});

describe("撤回後刪除白名單與包含關係", () => {
  it("刪除白名單不恢復封鎖", async () => {
    await boot();
    const id = await putBlock("64.0.113.7/32", "auto");
    const c = await cookie("admin1", "pass-admin-1");
    const allowId = ((await postWl(c, "64.0.113.0/24")).json() as { entry_id: string }).entry_id;
    expect((await app.inject({ method: "DELETE", url: entryPath(allowId), headers: cookieHeader(c) })).statusCode).toBe(204);
    expect((await blocks()).find((r) => r.entry_id === id)).toMatchObject({ revoked_at: String(NOW), ended_at: String(NOW) });
  });

  it("只撤回被 CIDR 完全包含的主機；緊鄰外側（IPv4／IPv6）不撤", async () => {
    // 黑名單只存 /32、/128，無法做出「封鎖前綴比白名單寬」的部分重疊夾具；最接近的是緊鄰網段外側的主機。
    await boot();
    const in4 = await putBlock("64.0.113.1/32", "auto");
    const out4 = await putBlock("64.0.113.128/32", "manual");
    const in6 = await putBlock("2400:cb00:1::5/128", "auto");
    const out6 = await putBlock("2400:cb01::1/128", "manual");
    const c = await cookie("admin1", "pass-admin-1");
    expect((await postWl(c, "64.0.113.0/25")).statusCode).toBe(201);
    expect((await postWl(c, "2400:cb00::/32")).statusCode).toBe(201);
    const revokedAt = async (id: string) => (await blocks()).find((r) => r.entry_id === id)?.revoked_at;
    expect(await revokedAt(in4)).toBe(String(NOW));
    expect(await revokedAt(out4)).toBeNull();
    expect(await revokedAt(in6)).toBe(String(NOW));
    expect(await revokedAt(out6)).toBeNull();
  });
});

describe("新增白名單與判定 tick 並行", () => {
  const IP = "64.0.113.7";
  async function prime(): Promise<string> {
    const admin = await cookie("admin1", "pass-admin-1");
    const uid = (await app.db.query<{ id: number }>("SELECT min(id) AS id FROM users")).rows[0]!.id;
    for (const sensor of ["s-1", "s-2"]) {
      await app.db.query(
        `INSERT INTO sensor_tokens (sensor_id, token_hash, created_by, created_at, revoked_at, allowed_cidrs, allowed_app_ids)
         VALUES ($1,'fake-hash-not-a-token',$2,$3,NULL,'{0.0.0.0/0}','{app-1,app-2}')`,
        [sensor, uid, T0 - DAY]);
    }
    const windows: Array<{ at: number; app: string; sensor: string }> = [
      { at: T0 - 25 * MIN, app: "app-1", sensor: "s-1" },
      { at: T0 - 15 * MIN, app: "app-2", sensor: "s-1" },
      { at: T0 - 5 * MIN, app: "app-1", sensor: "s-1" },
    ];
    for (const w of windows) {
      await insertFlowEvents(app.db, Array.from({ length: 30 }, (_, i) => ({
        flow: flowEvent(IP, w.at, 2000 + i, true, w.app), sensorId: w.sensor, receivedAt: w.at + 10_000,
      })));
    }
    return admin;
  }
  const active = async () =>
    (await app.db.query<{ ip: string }>(
      "SELECT ip FROM blocklist_entries WHERE revoked_at IS NULL AND ended_at IS NULL")).rows;
  const autoListN = async () => Number((await app.db.query<{ n: string }>(
    "SELECT count(*) AS n FROM audit_events WHERE action = 'blacklist.auto_list'")).rows[0]!.n);

  it("tick 上榜前先完成新增 → IP 未封鎖、無 auto_list，不發生死結", async () => {
    app = await bootJudgeApp({ databaseUrl: lockGuardedUrl() });
    const admin = await prime();
    let status = 0;
    await runJudgeTick(app.db, T0, undefined, {
      autoListEnabled: true,
      beforeAutoList: async () => { status = (await postWl(admin, "64.0.113.0/24")).statusCode; },
    });
    expect(status).toBe(201);
    expect(await active()).toEqual([]);
    expect(await autoListN()).toBe(0);
  }, LOCK_TEST_TIMEOUT_MS);

  it("tick 持有 SHARE 與 AUTO_LOCK 時新增會等鎖，放鎖後完成且不發生死結", async () => {
    app = await bootJudgeApp({ databaseUrl: lockGuardedUrl() });
    const admin = await cookie("admin1", "pass-admin-1");
    const hold = await holdShareAndAutoLock();
    const pending = postWl(admin, "64.0.113.0/24");
    const waiter = await waitShareWaiter(app.db, 3000, "RowExclusiveLock");
    await hold.commit();
    expect(waiter).not.toBeNull();
    expect((await pending).statusCode).toBe(201);
  }, LOCK_TEST_TIMEOUT_MS);
});
