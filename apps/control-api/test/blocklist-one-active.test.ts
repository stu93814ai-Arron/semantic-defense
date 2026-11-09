import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { writeAutoBlocklistEntry } from "../src/auto-blacklist.js";
import { insertActiveBlocklistEntry } from "../src/blocklist-store.js";

/** 成案流程 Q8／Q9：同 IP 只能有一筆生效黑名單（ended_at＋partial UNIQUE(ip) WHERE ended_at IS NULL＋同 tx sweep＋ON CONFLICT DO NOTHING）。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const T0 = Date.parse("2026-11-09T00:00:00Z");
const DAY = 24 * 3600_000;
let now = T0;
async function boot(): Promise<ControlApi> {
  now = T0;
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => now });
  await seedPhase2Fixtures(app);
  return app;
}
const IP = "64.0.113.7";
const auto = (at: number, ip = IP) => writeAutoBlocklistEntry(app.db, { ip, confidence: 0.95, case_id: randomUUID() }, at);
type Row = { entry_id: string; ip: string; expires_at: string; ended_at: string | null };
const rows = async () => (await app.db.query<Row>(
  "SELECT entry_id, ip, expires_at, ended_at FROM blocklist_entries ORDER BY created_at, entry_id")).rows;
const autoAudits = async () => Number((await app.db.query<{ n: string }>(
  "SELECT count(*) AS n FROM audit_events WHERE action = 'blacklist.auto_list'")).rows[0]!.n);

describe("黑名單同 IP 唯一生效", () => {
  it("兩個 tx 同時寫同一 IP → 只有 1 列；一邊 listed、一邊 already_listed；只有 1 筆 auto_list 稽核", async () => {
    await boot();
    const out = await Promise.all([auto(T0), auto(T0)]);
    expect(out.map((r) => r.status).sort()).toEqual(["already_listed", "listed"]);
    expect(await rows()).toHaveLength(1);
    expect(await autoAudits()).toBe(1);
  });

  it("生效中再寫 → already_listed：不延長 expires_at、不新增列、不寫 auto_list 稽核", async () => {
    await boot();
    await auto(T0);
    expect(await auto(T0 + DAY - 1)).toEqual({ status: "already_listed" });
    expect((await rows()).map((r) => [Number(r.expires_at), r.ended_at])).toEqual([[T0 + DAY, null]]);
    expect(await autoAudits()).toBe(1);
  });

  it("已過期但未撤回 → 可再寫；舊列 ended_at＝expires_at（sweep），新列 ended_at NULL", async () => {
    await boot();
    await auto(T0);
    expect((await auto(T0 + DAY)).status).toBe("listed");
    expect((await rows()).map((r) => [Number(r.expires_at), r.ended_at === null ? null : Number(r.ended_at)]))
      .toEqual([[T0 + DAY, T0 + DAY], [T0 + 2 * DAY, null]]);
  });

  it("撤回設 ended_at＝撤回時間；撤回後同 IP 可再寫", async () => {
    await boot();
    const first = await auto(T0);
    if (first.status !== "listed") throw new Error(first.status);
    now = T0 + 60_000;
    const c = (await login(app, { username: "operator1", password: "pass-operator-1" })).cookie!;
    const r = await app.inject({ method: "POST", url: ADMIN_API_PATHS.blacklistRevoke.replace(":entryId", first.entry.entry_id),
      headers: cookieHeader(c) });
    expect(r.statusCode).toBe(200);
    expect((await rows())[0]!.ended_at).toBe(String(T0 + 60_000));
    expect((await auto(T0 + 120_000)).status).toBe("listed");
    expect((await rows()).map((x) => x.ended_at === null)).toEqual([false, true]);
  });

  it("DB 層保證：繞過函式直接 INSERT 第二筆生效列 → 違反唯一約束；/24 與其中 /32 可並存", async () => {
    await boot();
    await auto(T0);
    const raw = (ip: string) => app.db.query(
      `INSERT INTO blocklist_entries (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at)
       VALUES ($1,$2,'manual',0.9,$3,$4,$5,'operator1',$4,NULL)`, [randomUUID(), ip, randomUUID(), T0, T0 + DAY]);
    await expect(raw(`${IP}/32`)).rejects.toMatchObject({ code: "23505", constraint: "blocklist_one_active" });
    await raw("64.0.113.0/24");
    expect((await rows()).map((x) => x.ip).sort()).toEqual(["64.0.113.0/24", `${IP}/32`]);
  });

  it("ended_at 只在 DB：CHECK ended_at >= created_at", async () => {
    await boot();
    await auto(T0);
    await expect(app.db.query("UPDATE blocklist_entries SET ended_at = $1", [T0 - 1])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("insertActiveBlocklistEntry 前綴護欄（資安殘留 4：程式錯誤的護欄，不加 DB CHECK）", () => {
  const draft = (ip: string) => ({ entry_id: randomUUID(), ip, source: "auto" as const, confidence: 0.95, case_id: randomUUID(),
    created_at: T0, expires_at: T0 + DAY, approved_by: "system:auto", approved_at: T0 });
  it.each(["64.0.113.7", "64.0.113.0/24", "2400:cb00::1", "2400:CB00::1/128", "2400:cb00:0::1/128", "2400:cb00::/64", "64.0.113.007/32"])(
    "非正規化 x/32、x/128（%s）→ 拋錯、不寫入", async (ip) => {
      await boot();
      await expect(app.db.tx((q) => insertActiveBlocklistEntry(q, draft(ip), T0))).rejects.toThrow(/x\/32|x\/128/);
      expect(await rows()).toEqual([]);
    });
  it("正規化 64.0.113.7/32、2400:cb00::1/128 → 寫入", async () => {
    await boot();
    for (const ip of ["64.0.113.7/32", "2400:cb00::1/128"]) {
      expect((await app.db.tx((q) => insertActiveBlocklistEntry(q, draft(ip), T0)))?.ip).toBe(ip);
    }
  });
});
