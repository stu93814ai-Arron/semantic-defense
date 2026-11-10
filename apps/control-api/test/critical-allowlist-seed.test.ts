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
const V6 = "2400:cb00::/32";
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

async function boot(env?: string): Promise<ControlApi> {
  if (env === undefined) delete process.env.SD_CRITICAL_ALLOWLIST;
  else process.env.SD_CRITICAL_ALLOWLIST = env;
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW });
  return app;
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
    const caseId = randomUUID();
    const v4 = await writeAutoBlocklistEntry(app!.db, { ip: "64.0.113.7", confidence: 0.95, case_id: caseId }, NOW);
    const v6 = await writeAutoBlocklistEntry(app!.db, { ip: "2400:cb00:1::5/128", confidence: 0.95, case_id: caseId }, NOW);
    expect([v4, v6]).toEqual([{ status: "allowlisted" }, { status: "allowlisted" }]);
    expect(Number((await app!.db.query<{ n: string }>("SELECT count(*) AS n FROM blocklist_entries")).rows[0]!.n)).toBe(0);
    expect(Number((await app!.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'blacklist.auto_list'")).rows[0]!.n)).toBe(0);
  });

  it("設定含非法 CIDR → buildApp 拋錯，訊息不含該 CIDR；不寫入本次種子", async () => {
    await wipeAllowlist();
    process.env.SD_CRITICAL_ALLOWLIST = `${V4},127.0.0.0/8`;
    let thrown: unknown;
    try {
      await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(/SD_CRITICAL_ALLOWLIST/);
    expect(String(thrown)).not.toMatch(/127\.0\.0\.0|64\.0\.113/);
    delete process.env.SD_CRITICAL_ALLOWLIST;
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

  it("從設定拿掉某 CIDR 後重啟，原種子列仍在", async () => {
    await wipeAllowlist();
    await boot(`${V4},${V6}`);
    await app!.close();
    app = undefined;
    await boot(V4);
    expect((await seeds()).map((r) => r.cidr).sort()).toEqual([V6, V4].sort());
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
