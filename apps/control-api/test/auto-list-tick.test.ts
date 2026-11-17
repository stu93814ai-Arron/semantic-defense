import { afterEach, describe, expect, it } from "vitest";
import { insertFlowEvents } from "@semantic-defense/flow-store/testing";
import { type ControlApi } from "./helpers/app.js";
import { DAY, HS_READY, MIN, T0, bootJudgeApp, flowEvent } from "./helpers/judge.js";
import { AUTO_LIST_ENABLED_DEFAULT, runJudgeTick } from "../src/judge.js";
import * as als from "../src/auto-list-settings.js";
import type { Queryable } from "../src/db.js";

/**
 * 判定 tick 每個 tick（JUDGE_LOCK 之後）讀 auto_list_settings；
 * 缺列或讀失敗視為關閉（fail-closed，SAVEPOINT）；
 * TickOpts／buildApp.autoListEnabled 僅測試覆寫（有傳入則跳過 DB）。
 * 實作後 it.fails 已改回 it()。
 */

const IP = "64.0.221.8";
const CIDR = `${IP}/32`;

let app: ControlApi | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

type TickLogBuf = { error(obj: object, msg: string): void; warn(obj: object, msg: string): void; errors: { obj: object; msg: string }[] };

function memLog(): TickLogBuf {
  const errors: { obj: object; msg: string }[] = [];
  return {
    errors,
    error(obj, msg) { errors.push({ obj, msg }); },
    warn() { /* tick 計數用，本檔不驗 */ },
  };
}

async function start(): Promise<ControlApi> {
  app = await bootJudgeApp();
  for (const sensor of ["s-1", "s-2"]) {
    await app.db.query(
      `INSERT INTO sensor_tokens (sensor_id, token_hash, created_by, created_at, revoked_at, allowed_cidrs, allowed_app_ids)
       VALUES ($1, 'fake-hash-not-a-token', (SELECT min(id) FROM users), $2, NULL, '{0.0.0.0/0}', '{app-1,app-2}')`,
      [sensor, T0 - DAY],
    );
  }
  return app;
}

const ingest = (at: number, appId: string) => insertFlowEvents(app!.db, Array.from({ length: 30 }, (_, i) => ({
  flow: flowEvent(IP, at, 4000 + i, true, appId), sensorId: "s-1", receivedAt: at + 10_000,
})));

/** E3.A 成立：30 分鐘內 3 窗、2 個 app。 */
const qualify = async () => {
  await ingest(T0 - 25 * MIN, "app-1");
  await ingest(T0 - 15 * MIN, "app-2");
  await ingest(T0 - 5 * MIN, "app-1");
};

const states = async () => (await app!.db.query<{ state: string }>(
  "SELECT state FROM blacklist_cases WHERE ip = $1", [CIDR])).rows.map((r) => r.state);
const autoListed = async () => (await app!.db.query(
  "SELECT 1 FROM blocklist_entries WHERE ip = $1 AND source = 'auto' AND ended_at IS NULL", [CIDR])).rows.length;

type InTx = (q: Queryable, log?: { error(obj: object, msg: string): void; warn?(obj: object, msg: string): void }) => Promise<boolean>;
function readInTx(): InTx {
  const fn = (als as Record<string, unknown>)["readAutoListEnabledInTx"];
  if (typeof fn !== "function") throw new Error("readAutoListEnabledInTx missing");
  return fn as InTx;
}

/** 本地 fake Queryable：只有讀開關的 SELECT 走 select()（可擲錯），其餘回空列；記下所有 SQL。 */
function fakeQ(select: () => unknown[]): { q: Queryable; sql: string[] } {
  const sql: string[] = [];
  const query = async (text: string) => {
    sql.push(text);
    return { rows: /SELECT\s+enabled\s+FROM\s+auto_list_settings/i.test(text) ? select() : [] };
  };
  return { q: { query } as unknown as Queryable, sql };
}

describe("判定 tick 讀取自動上榜開關", () => {
  it("AUTO_LIST_ENABLED_DEFAULT 仍為缺列 fallback（false）", () => {
    expect(AUTO_LIST_ENABLED_DEFAULT).toBe(false);
  });

  it("對照：DB 為 true、只傳三向交握就緒覆寫（不傳 autoListEnabled）→ 讀 DB，E3.A 成立則自動上榜", async () => {
    await start();
    await app!.db.query("UPDATE auto_list_settings SET enabled = TRUE");
    await qualify();
    await runJudgeTick(app!.db, T0, undefined, HS_READY);
    expect([await autoListed(), await states()]).toEqual([1, ["auto_listed"]]);
  });

  it.fails("DB 為 true、未傳覆寫、HANDSHAKE_EVIDENCE_READY=false → 不自動上榜，案件仍開案留待審", async () => {
    await start();
    await app!.db.query("UPDATE auto_list_settings SET enabled = TRUE");
    await qualify();
    const result = await runJudgeTick(app!.db, T0);
    expect(result.hits).toBeGreaterThan(0);
    expect([await autoListed(), await states()]).toEqual([0, ["open"]]);
  });

  it("未傳覆寫且 DB 為 false：E3.A 成立也只留待審、不上榜", async () => {
    await start();
    await qualify();
    await runJudgeTick(app!.db, T0);
    expect([await autoListed(), await states()]).toEqual([0, ["open"]]);
  });

  it("缺列視為關閉（fallback 常數），案件留待審", async () => {
    await start();
    await app!.db.query("DELETE FROM auto_list_settings");
    await qualify();
    await runJudgeTick(app!.db, T0);
    expect([await autoListed(), await states()]).toEqual([0, ["open"]]);
  });

  it("DB 關閉時凍結熔斷；只改開關不動熔斷；改為 true 後下一個 tick 才補判恢復", async () => {
    await start();
    const at = String(T0 - 70 * MIN);
    await app!.db.query("UPDATE auto_breaker SET opened_at = $1 WHERE id", [at]);
    const closes = async () => (await app!.db.query(
      "SELECT 1 FROM audit_events WHERE action = 'blacklist.auto_breaker_close'")).rows.length;
    const opened = async () => (await app!.db.query<{ opened_at: string | null }>(
      "SELECT opened_at FROM auto_breaker")).rows[0]!.opened_at;
    await runJudgeTick(app!.db, T0);
    expect([await closes(), await opened()]).toEqual([0, at]);
    await app!.db.query("UPDATE auto_list_settings SET enabled = TRUE");
    expect(await opened()).toBe(at);
    await runJudgeTick(app!.db, T0 + MIN, undefined, HS_READY);
    expect([await closes(), await opened()]).toEqual([1, null]);
  });
});

describe("測試覆寫跳過 DB、讀失敗 fail-closed", () => {
  it("autoListEnabled:true 覆寫：DB 為 false 仍上榜（不讀列）", async () => {
    await start();
    await qualify();
    await runJudgeTick(app!.db, T0, undefined, { autoListEnabled: true, ...HS_READY });
    expect([await autoListed(), await states()]).toEqual([1, ["auto_listed"]]);
  });

  it("autoListEnabled:false 覆寫：DB 為 true 仍不上榜", async () => {
    await start();
    await app!.db.query("UPDATE auto_list_settings SET enabled = TRUE");
    await qualify();
    await runJudgeTick(app!.db, T0, undefined, { autoListEnabled: false });
    expect([await autoListed(), await states()]).toEqual([0, ["open"]]);
  });

  it("本地 fake Queryable 讀成功：回列值、RELEASE SAVEPOINT、不記 error", async () => {
    const { q, sql } = fakeQ(() => [{ enabled: true }]);
    const log = memLog();
    await expect(readInTx()(q, log)).resolves.toBe(true);
    expect(log.errors).toEqual([]);
    expect(sql.some((s) => /RELEASE SAVEPOINT\s+auto_list_setting/i.test(s))).toBe(true);
  });

  it("本地 fake Queryable 讀失敗：回 false，只記 error_class，並 ROLLBACK TO SAVEPOINT", async () => {
    const { q, sql } = fakeQ(() => {
      throw Object.assign(new Error("injected boom must not be logged"), { code: "XX000" });
    });
    const log = memLog();
    await expect(readInTx()(q, log)).resolves.toBe(false);
    expect(log.errors.map((e) => e.obj)).toEqual([{ error_class: "auto_list_setting_read" }]);
    expect(JSON.stringify(log.errors)).not.toContain("injected boom");
    expect(sql.some((s) => /SAVEPOINT\s+auto_list_setting/i.test(s))).toBe(true);
    expect(sql.some((s) => /ROLLBACK TO SAVEPOINT\s+auto_list_setting/i.test(s))).toBe(true);
  });

  it("tick 內讀失敗（檢視擲錯）不中止交易：仍開案、視為關閉、只記 error_class", async () => {
    await start();
    await qualify();
    await app!.db.exec("ALTER TABLE auto_list_settings RENAME TO auto_list_settings_hid");
    await app!.db.exec(
      "CREATE VIEW auto_list_settings AS SELECT id, (1 / 0)::boolean AS enabled FROM auto_list_settings_hid",
    );
    const log = memLog();
    try {
      const result = await runJudgeTick(app!.db, T0, log);
      expect(result.ran).toBe(true);
      expect(result.hits).toBeGreaterThan(0);
      expect([await autoListed(), await states()]).toEqual([0, ["open"]]);
      expect(log.errors.map((e) => e.obj)).toEqual([{ error_class: "auto_list_setting_read" }]);
      expect(JSON.stringify(log.errors)).not.toMatch(/division|除以|1 \/ 0|auto_list_settings_hid/i);
    } finally {
      await app!.db.exec("DROP VIEW IF EXISTS auto_list_settings");
      await app!.db.exec("ALTER TABLE IF EXISTS auto_list_settings_hid RENAME TO auto_list_settings");
    }
  });
});
