import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts";
import { openDb } from "../src/db.js";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { writeAutoBlocklistEntry } from "./helpers/auto-list.js";
import { randomUUID } from "node:crypto";

/** 安裝時關鍵基礎設施白名單：SD_CRITICAL_ALLOWLIST，種子不可刪、不可設到期。 */
const NOW = Date.parse("2026-11-09T00:00:00Z");
const V4 = "64.0.113.0/24";
const V6 = "2400:cb00::/48";
const one = (id: string) => ADMIN_API_PATHS.whitelistEntry.replace(":entryId", id);

let app: ControlApi | undefined;
afterEach(async () => {
  delete process.env.SD_CRITICAL_ALLOWLIST;
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function wipeAllowlist(): Promise<void> {
  const db = await openDb(requireDatabaseUrl());
  await db.exec("TRUNCATE TABLE allowlist_entries CASCADE");
  await db.close();
}

async function boot(env?: string, opts: Parameters<typeof buildApp>[0] = {}): Promise<ControlApi> {
  if (env === undefined) delete process.env.SD_CRITICAL_ALLOWLIST;
  else process.env.SD_CRITICAL_ALLOWLIST = env;
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW, ...opts });
  return app;
}


async function expectBootRejects(env: string): Promise<string> {
  await wipeAllowlist();
  process.env.SD_CRITICAL_ALLOWLIST = env;
  let thrown: unknown;
  try {
    await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW });
  } catch (err) {
    thrown = err;
  }
  delete process.env.SD_CRITICAL_ALLOWLIST;
  expect(thrown).toBeInstanceOf(Error);
  return String(thrown);
}

async function bootUsers(env: string): Promise<string> {
  await boot(env);
  await seedPhase2Fixtures(app!);
  await app!.close();
  app = undefined;
  await boot(env);
  const r = await login(app!, { username: "admin1", password: "pass-admin-1" });
  expect(r.status).toBe(200);
  return r.cookie!;
}

const seeds = async () =>
  (await app!.db.query<{ entry_id: string; cidr: string; created_by: string; expires_at: string | null; reason: string }>(
    "SELECT entry_id, cidr, created_by, expires_at, reason FROM allowlist_entries WHERE created_by = 'system:install' ORDER BY cidr",
  )).rows;

describe("SD_CRITICAL_ALLOWLIST 安裝種子", () => {
  it("未設定或空字串 → 不寫入種子列", async () => {
    await wipeAllowlist();
    await boot();
    expect(await seeds()).toEqual([]);
    await app!.close();
    app = undefined;
    await boot("");
    expect(await seeds()).toEqual([]);
  });

  it("逗號分隔的公網 CIDR（含空白）啟動時寫入；created_by=system:install、expires_at 為 null；重跑冪等", async () => {
    await wipeAllowlist();
    await boot(` ${V4} , ${V6} `);
    const first = await seeds();
    expect(first.map((r) => [r.cidr, r.created_by, r.expires_at, r.reason])).toEqual([
      [V6, "system:install", null, "critical-infrastructure"],
      [V4, "system:install", null, "critical-infrastructure"],
    ]);
    await app!.close();
    app = undefined;
    await boot(`${V4},${V6}`);
    const second = await seeds();
    expect(second.map((r) => r.entry_id).sort()).toEqual(first.map((r) => r.entry_id).sort());
    expect(second).toHaveLength(2);
  });

  it("種子 CIDR 內的位址 → autoListInTx 回 allowlisted，不上榜、不寫 auto_list 稽核", async () => {
    await wipeAllowlist();
    await boot(`${V4},${V6}`);
    await app!.db.exec("TRUNCATE TABLE blocklist_entries, audit_events CASCADE");
    const caseId = randomUUID();
    const v4 = await writeAutoBlocklistEntry(app!.db, { ip: "64.0.113.7", confidence: 0.95, case_id: caseId }, NOW);
    const v6 = await writeAutoBlocklistEntry(app!.db, { ip: "2400:cb00::5/128", confidence: 0.95, case_id: caseId }, NOW);
    expect([v4, v6]).toEqual([{ status: "allowlisted" }, { status: "allowlisted" }]);
    expect(Number((await app!.db.query<{ n: string }>("SELECT count(*) AS n FROM blocklist_entries")).rows[0]!.n)).toBe(0);
    expect(Number((await app!.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'blacklist.auto_list'")).rows[0]!.n)).toBe(0);
  });

  it("設定含非法 CIDR → buildApp 拋錯，訊息不含該 CIDR；不寫入本次種子", async () => {
    const msg = await expectBootRejects(`${V4},127.0.0.0/8`);
    expect(msg).toMatch(/SD_CRITICAL_ALLOWLIST/);
    expect(msg).not.toMatch(/127\.0\.0\.0|64\.0\.113/);
    const db = await openDb(requireDatabaseUrl());
    const n = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM allowlist_entries WHERE created_by = 'system:install'")).rows[0]!.n);
    await db.close();
    expect(n).toBe(0);
  });

  it("seedPhase2Fixtures 清空後，重啟依設定補回種子", async () => {
    await boot(`${V4}`);
    await seedPhase2Fixtures(app!);
    expect(await seeds()).toEqual([]);
    await app!.close();
    app = undefined;
    await boot(`${V4}`);
    expect((await seeds()).map((r) => r.cidr)).toEqual([V4]);
  });

});


const wlAudits = async (action: string) =>
  (await app!.db.query<{ actor: string; at: string; detail: Record<string, unknown> }>(
    "SELECT actor, at, detail FROM audit_events WHERE action = $1 ORDER BY id", [action])).rows;

describe("SD_CRITICAL_ALLOWLIST 前綴上限", () => {
  it("IPv4 /16 與 IPv6 /48 可啟動", async () => {
    for (const cidr of ["64.0.0.0/16", "2400:cb00::/48"]) {
      await wipeAllowlist();
      await boot(cidr);
      expect((await seeds()).map((r) => r.cidr)).toEqual([cidr]);
      await app!.close();
      app = undefined;
    }
  });

  it("IPv4 /15 與 IPv6 /47 使 buildApp 拋錯，訊息不含該值", async () => {
    for (const cidr of ["64.0.0.0/15", "2400:cb00::/47"]) {
      const msg = await expectBootRejects(cidr);
      expect(msg).toMatch(/SD_CRITICAL_ALLOWLIST/);
      expect(msg).not.toContain(cidr);
    }
  });
});

describe("安裝種子與設定同步", () => {
  it("新插入的種子寫 whitelist.create；再次啟動無新列則不寫 create／delete 稽核", async () => {
    await clearLists();
    await boot(V4);
    const [row] = await seeds();
    const creates = await wlAudits("whitelist.create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      actor: "system:install", at: String(NOW),
      detail: {
        entry_id: row!.entry_id, cidr: V4, reason: "critical-infrastructure",
        created_by: "system:install", created_at: new Date(NOW).toISOString(), expires_at: null,
      },
    });
    await app!.close();
    app = undefined;
    await boot(V4);
    expect(await wlAudits("whitelist.create")).toHaveLength(1);
    expect(await wlAudits("whitelist.delete")).toHaveLength(0);
  });

  it("從設定拿掉的種子會在啟動時刪除並寫 whitelist.delete，不恢復已撤回封鎖", async () => {
    await clearLists();
    const blockId = await addBlock("64.0.113.7/32", "auto");
    await boot(`${V4},${V6}`);
    const v4id = (await seeds()).find((r) => r.cidr === V4)!.entry_id;
    expect((await listedBlocks()).find((r) => r.entry_id === blockId)?.revoked_at).toBe(String(NOW));
    await app!.close();
    app = undefined;
    await boot(V6);
    expect((await seeds()).map((r) => r.cidr)).toEqual([V6]);
    const dels = await wlAudits("whitelist.delete");
    expect(dels).toHaveLength(1);
    expect(dels[0]).toMatchObject({
      actor: "system:install", at: String(NOW),
      detail: { entry_id: v4id, cidr: V4, created_by: "system:install", expires_at: null },
    });
    expect((await listedBlocks()).find((r) => r.entry_id === blockId)?.revoked_at).toBe(String(NOW));
  });

});


describe("未設定或空值保留種子，none 才清空", () => {
  async function seedThen(next?: string): Promise<string> {
    await clearLists();
    await boot(V4);
    const id = (await seeds())[0]!.entry_id;
    await app!.close();
    app = undefined;
    await boot(next);
    return id;
  }

  it("未設定時保留既有種子，不寫 delete、不撤回封鎖", async () => {
    await clearLists();
    const blockId = await addBlock("64.0.113.7/32", "auto");
    await boot(V4);
    const id = (await seeds())[0]!.entry_id;
    expect((await listedBlocks()).find((r) => r.entry_id === blockId)?.revoked_at).toBe(String(NOW));
    const revokes = (await revokeAudits()).length;
    await app!.close();
    app = undefined;
    await boot();
    expect((await seeds()).map((r) => r.entry_id)).toEqual([id]);
    expect(await wlAudits("whitelist.delete")).toHaveLength(0);
    expect((await revokeAudits()).length).toBe(revokes);
    expect((await listedBlocks()).find((r) => r.entry_id === blockId)?.revoked_at).toBe(String(NOW));
  });

  it("空字串（含只空白）時保留既有種子，不寫 delete", async () => {
    const id = await seedThen("   ");
    expect((await seeds()).map((r) => r.entry_id)).toEqual([id]);
    expect(await wlAudits("whitelist.delete")).toHaveLength(0);
  });

  it("none 刪除全部種子並為每列寫 whitelist.delete，warn 只含筆數、不含 IP", async () => {
    await clearLists();
    const blockId = await addBlock("64.0.113.7/32", "auto");
    await boot(`${V4},${V6}`);
    const ids = (await seeds()).map((r) => r.entry_id).sort();
    expect((await listedBlocks()).find((r) => r.entry_id === blockId)?.revoked_at).toBe(String(NOW));
    await app!.close();
    app = undefined;
    const lines: string[] = [];
    await boot("none", { logger: { level: "warn", stream: { write: (l: string) => { lines.push(l); } } } });
    expect(await seeds()).toEqual([]);
    const dels = await wlAudits("whitelist.delete");
    expect(dels).toHaveLength(2);
    expect(dels.every((a) => a.actor === "system:install")).toBe(true);
    expect(dels.map((a) => a.detail.entry_id).sort()).toEqual(ids);
    expect((await listedBlocks()).find((r) => r.entry_id === blockId)?.revoked_at).toBe(String(NOW));
    const warns = lines.filter((l) => l.includes("critical allowlist seeds deleted"));
    expect(warns).toHaveLength(1);
    expect(JSON.parse(warns[0]!) as { count: number; level: number }).toMatchObject({ level: 40, count: 2 });
    expect(warns[0]).not.toMatch(/64\.0\.113|2400:cb00/);
  });

  it("none 與 CIDR 混用使 buildApp 拋錯，訊息不含該值", async () => {
    const msg = await expectBootRejects(`none,${V4}`);
    expect(msg).toMatch(/SD_CRITICAL_ALLOWLIST/);
    expect(msg).not.toContain(V4);
    expect(msg).not.toMatch(/64\.0\.113/);
  });
});

describe("種子 CIDR 必須含前綴", () => {
  it("單一 IP 無前綴使 buildApp 拋錯，訊息為須含前綴而非寬於 /16，且不含該值", async () => {
    const ip = "64.0.113.7";
    const msg = await expectBootRejects(ip);
    expect(msg).toMatch(/CIDR must include a prefix/);
    expect(msg).not.toMatch(/broader than \/16/);
    expect(msg).not.toContain(ip);
  });
});

describe("同步只動 created_by=system:install 的種子", () => {
  it("管理員新增的白名單列在 none 清空種子後仍保留", async () => {
    await clearLists();
    await boot(V4);
    const seedId = (await seeds())[0]!.entry_id;
    const adminId = randomUUID();
    await app!.db.query(
      `INSERT INTO allowlist_entries (entry_id, cidr, reason, created_by, created_at, expires_at)
       VALUES ($1,'198.51.100.0/24','office','admin1',$2,NULL)`,
      [adminId, NOW],
    );
    await app!.close();
    app = undefined;
    await boot("none");
    expect((await seeds()).map((r) => r.entry_id)).toEqual([]);
    const left = (await app!.db.query<{ entry_id: string; created_by: string }>(
      "SELECT entry_id, created_by FROM allowlist_entries ORDER BY created_by",
    )).rows;
    expect(left).toEqual([{ entry_id: adminId, created_by: "admin1" }]);
    expect(left.some((r) => r.entry_id === seedId)).toBe(false);
  });
});

describe("安裝種子不可改", () => {
  it("DELETE 種子或 PATCH 設定到期 → 409，列不變", async () => {
    await wipeAllowlist();
    const cookie = await bootUsers(V4);
    const [row] = await seeds();
    const del = await app!.inject({ method: "DELETE", url: one(row!.entry_id), headers: cookieHeader(cookie) });
    const patch = await app!.inject({
      method: "PATCH", url: one(row!.entry_id), headers: cookieHeader(cookie),
      payload: { reason: "改期", expires_at: "2026-11-10T00:00:00.000Z" },
    });
    expect([del.statusCode, patch.statusCode]).toEqual([409, 409]);
    const after = await seeds();
    expect(after).toEqual([row]);
  });
});


const BLOCK_CREATED = NOW - 60_000;
const BLOCK_DAY = 24 * 3600_000;

async function clearLists(): Promise<void> {
  delete process.env.SD_CRITICAL_ALLOWLIST;
  const db = await openDb(requireDatabaseUrl());
  await db.exec("TRUNCATE TABLE allowlist_entries, blocklist_entries, audit_events CASCADE");
  await db.close();
}

async function addBlock(ip: string, source: "auto" | "manual"): Promise<string> {
  delete process.env.SD_CRITICAL_ALLOWLIST;
  const db = await openDb(requireDatabaseUrl());
  const id = randomUUID();
  await db.query(
    `INSERT INTO blocklist_entries
      (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at, ended_at)
     VALUES ($1,$2,$3,0.95,$4,$5,$6,$7,$5,NULL,NULL)`,
    [id, ip, source, randomUUID(), BLOCK_CREATED, BLOCK_CREATED + BLOCK_DAY, source === "auto" ? "system:auto" : "admin1"],
  );
  await db.close();
  return id;
}

const listedBlocks = async () =>
  (await app!.db.query<{ entry_id: string; ip: string; revoked_at: string | null }>(
    "SELECT entry_id, ip, revoked_at FROM blocklist_entries ORDER BY ip")).rows;
const revokeAudits = async () =>
  (await app!.db.query<{ actor: string; at: string; detail: Record<string, unknown> }>(
    "SELECT actor, at, detail FROM audit_events WHERE action = 'blacklist.revoke' ORDER BY id")).rows;

describe("安裝種子撤回既有封鎖", () => {
  it("啟動前已存在的生效封鎖（auto 與 manual）會被撤回，稽核 actor 為 system:install", async () => {
    await clearLists();
    const autoId = await addBlock("64.0.113.7/32", "auto");
    const manId = await addBlock("64.0.113.8/32", "manual");
    await boot(V4);
    const seedId = (await seeds())[0]!.entry_id;
    const rows = await listedBlocks();
    expect(rows.find((r) => r.entry_id === autoId)?.revoked_at).toBe(String(NOW));
    expect(rows.find((r) => r.entry_id === manId)?.revoked_at).toBe(String(NOW));
    const audits = await revokeAudits();
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actor === "system:install" && Number(a.at) === NOW)).toBe(true);
    expect(audits.map((a) => a.detail).sort((x, y) => String(x.ip).localeCompare(String(y.ip)))).toEqual([
      { entry_id: autoId, ip: "64.0.113.7/32", source: "auto", case_id: expect.any(String), allowlist_entry_id: seedId },
      { entry_id: manId, ip: "64.0.113.8/32", source: "manual", case_id: expect.any(String), allowlist_entry_id: seedId },
    ]);
  });

  it("第二次啟動沒有新的撤回則不寫稽核；其後才新增的封鎖會在再啟動時撤回（沿用既有種子 id）", async () => {
    await clearLists();
    const firstId = await addBlock("64.0.113.7/32", "auto");
    await boot(V4);
    const seedId = (await seeds())[0]!.entry_id;
    expect((await revokeAudits()).map((a) => a.detail.entry_id)).toEqual([firstId]);
    await app!.close();
    app = undefined;
    await boot(V4);
    expect((await revokeAudits()).map((a) => a.detail.entry_id)).toEqual([firstId]);
    const laterId = randomUUID();
    await app!.db.query(
      `INSERT INTO blocklist_entries
        (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at, ended_at)
       VALUES ($1,'64.0.113.9/32','auto',0.95,$2,$3,$4,'system:auto',$3,NULL,NULL)`,
      [laterId, randomUUID(), BLOCK_CREATED, BLOCK_CREATED + BLOCK_DAY],
    );
    await app!.close();
    app = undefined;
    await boot(V4);
    const after = await revokeAudits();
    expect(after.map((a) => a.detail.entry_id)).toEqual([firstId, laterId]);
    expect(after[1]).toMatchObject({
      actor: "system:install", at: String(NOW),
      detail: { entry_id: laterId, ip: "64.0.113.9/32", source: "auto", allowlist_entry_id: seedId },
    });
    expect((await seeds())[0]!.entry_id).toBe(seedId);
  });

  it("緊鄰 CIDR 外側的位址不會被撤回", async () => {
    await clearLists();
    const inside = await addBlock("64.0.113.1/32", "auto");
    const outside = await addBlock("64.0.113.128/32", "manual");
    await boot("64.0.113.0/25");
    const rows = await listedBlocks();
    expect(rows.find((r) => r.entry_id === inside)?.revoked_at).toBe(String(NOW));
    expect(rows.find((r) => r.entry_id === outside)?.revoked_at).toBeNull();
    expect((await revokeAudits()).map((a) => a.detail.entry_id)).toEqual([inside]);
  });
});
