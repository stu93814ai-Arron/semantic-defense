import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { insertFlowEvents } from "@semantic-defense/flow-store/testing";
import { buildApp, type ControlApi } from "./helpers/app.js";
import { DAY, MIN, T0, auditIndexDefAfterReinit, bootJudgeApp, flowEvent } from "./helpers/judge.js";
import { AUTO_LIST_ENABLED_DEFAULT, runJudgeTick, type TickOpts } from "../src/judge.js";
import { autoListInTx } from "../src/auto-blacklist.js";
import { writeAutoBlocklistEntry } from "./helpers/auto-list.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { LOCK_TEST_TIMEOUT_MS, LOCK_TIMEOUT_MS, holdAllowlistInsert, holdsAdvisory, lockGuardedUrl, waitShareWaiter } from "./helpers/locks.js";
import { AUTO_LOCK } from "../src/auto-breaker.js";

/**
 * 成案流程 commit 9：E3.A 自動上榜條件（計畫 §1 步驟 4、§6.1、§7；A 組領航員裁定 11-09）。
 * 30 分鐘內 ≥3 次高嚴重命中（ontime_confidence ≥ auto），且 ≥2 個已綁定的 app_id 或 sensor_id。
 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const IP = "64.0.113.20";
const CIDR = `${IP}/32`;
async function boot(tokens: Record<string, string[]> = { "s-1": ["app-1", "app-2"], "s-2": ["app-1", "app-2"] },
  opts: Parameters<typeof bootJudgeApp>[0] = {}) {
  app = await bootJudgeApp(opts);
  for (const [sensor, apps] of Object.entries(tokens)) await token(sensor, apps);
}
const token = (sensor: string, apps: string[], revoked: number | null = null) => app.db.query(
  `INSERT INTO sensor_tokens (sensor_id, token_hash, created_by, created_at, revoked_at, allowed_cidrs, allowed_app_ids)
   VALUES ($1, 'fake-hash-not-a-token', (SELECT min(id) FROM users), $2, $3, '{0.0.0.0/0}', $4)`,
  [sensor, T0 - DAY, revoked, apps]);
/** 一次命中：某 sensor／app 在 ts 所在 5 分鐘窗打 n 筆可疑 flow；預設準時收到（received = ts + 10s）。 */
const hit = (o: { at: number; app?: string; sensor?: string; late?: boolean; n?: number; port0?: number; ip?: string }) =>
  insertFlowEvents(app.db, Array.from({ length: o.n ?? 30 }, (_, i) => ({
    flow: flowEvent(o.ip ?? IP, o.at, (o.port0 ?? 1000) + i, true, o.app ?? "app-1"), sensorId: o.sensor ?? "s-1",
    receivedAt: o.at + (o.late ? 10 * MIN : 10_000),
  })));
const listed = async () => (await app.db.query<{ ip: string; source: string; case_id: string; confidence: number }>(
  "SELECT ip, source, case_id, confidence FROM blocklist_entries")).rows;
const kases = async () => (await app.db.query<{ case_id: string; ip: string; state: string; resolved_by: string | null }>(
  "SELECT case_id, ip, state, resolved_by FROM blacklist_cases ORDER BY created_at")).rows;
const audits = async (action: string) => (await app.db.query<{ actor: string; sensor_id: string | null; detail: Record<string, unknown> }>(
  "SELECT actor, sensor_id, detail FROM audit_events WHERE action = $1 ORDER BY id", [action])).rows;
/** 本檔測 E3.A 自動上榜：tick 一律明確開啟總開關（預設關，見檔尾 autoListEnabled 測試）。 */
const ON = { autoListEnabled: true } as const;
const tick = (at = T0, opts: TickOpts = {}) => runJudgeTick(app.db, at, undefined, { ...ON, ...opts });
/** 三個不同窗（T0−25m、−15m、−5m）的命中。 */
const three = async (apps: [string, string, string], sensors: [string, string, string] = ["s-1", "s-1", "s-1"]) => {
  const plan = [[25, apps[0], sensors[0]], [15, apps[1], sensors[1]], [5, apps[2], sensors[2]]] as const;
  for (const [off, a, sensor] of plan) await hit({ at: T0 - off * MIN, app: a, sensor });
};

describe("E3.A：有案路徑", () => {
  it("單次高分（1.0）→ 只進待審，不上榜", async () => {
    await boot();
    await hit({ at: T0 - 5 * MIN });
    await tick();
    expect([await listed(), (await kases()).map((c) => c.state)]).toEqual([[], ["open"]]);
  });

  it("同 sensor、同 app 3 次 → 待審（來源不足 2）", async () => {
    await boot();
    await three(["app-1", "app-1", "app-1"]);
    await tick();
    expect([await listed(), (await kases()).map((c) => c.state)]).toEqual([[], ["open"]]);
  });

  it("30 分鐘內 3 次、2 個 app → 自動上榜（confidence＝case max）＋auto_list 稽核，case 改 auto_listed", async () => {
    await boot();
    await three(["app-1", "app-2", "app-1"]);
    await tick();
    const [c] = await kases();
    expect(c).toMatchObject({ ip: CIDR, state: "auto_listed", resolved_by: "system:auto" });
    expect(await listed()).toEqual([{ ip: CIDR, source: "auto", case_id: c!.case_id, confidence: 1 }]);
    expect((await audits("blacklist.auto_list")).map((a) => a.detail.case_id)).toEqual([c!.case_id]);
  });

  it("3 次、2 個 sensor（同 app）→ 自動上榜", async () => {
    await boot();
    await three(["app-1", "app-1", "app-1"], ["s-1", "s-2", "s-1"]);
    await tick();
    expect((await listed()).map((e) => e.ip)).toEqual([CIDR]);
  });

  it("第 1 次與第 3 次相隔超過 30 分鐘 → 待審", async () => {
    await boot();
    for (const [off, a] of [[40, "app-1"], [15, "app-2"], [5, "app-1"]] as const) await hit({ at: T0 - off * MIN, app: a });
    await tick();
    expect(await listed()).toEqual([]);
  });

  it("高分但遲到的命中不計 → 待審", async () => {
    await boot();
    await hit({ at: T0 - 25 * MIN, app: "app-1" });
    await hit({ at: T0 - 15 * MIN, app: "app-2", late: true });
    await hit({ at: T0 - 5 * MIN, app: "app-1" });
    await tick(T0 + 10 * MIN);
    expect(await listed()).toEqual([]);
  });

  it("token 撤銷後該 sensor 的命中不計；app 解除綁定後該 app 的命中不計", async () => {
    await boot({ "s-1": ["app-1"] });
    await token("s-2", ["app-1"], T0 - MIN);
    await three(["app-1", "app-1", "app-1"], ["s-1", "s-2", "s-1"]);
    await three(["app-2", "app-2", "app-2"]);
    await tick();
    expect(await listed()).toEqual([]);
  });

  it("命中重掃時才跨過 auto（≈0.69 → 1.0）也算新的高嚴重命中 → 上榜", async () => {
    await boot();
    await hit({ at: T0 - 25 * MIN, app: "app-1" });
    await hit({ at: T0 - 15 * MIN, app: "app-2" });
    await hit({ at: T0 - 5 * MIN, app: "app-1", n: 10 });
    await tick();
    expect(await listed()).toEqual([]);
    await hit({ at: T0 - 5 * MIN, app: "app-1", n: 20, port0: 3000 });
    await tick(T0 + 20_000);
    expect((await listed()).map((e) => e.ip)).toEqual([CIDR]);
  });
});

describe("E3.A 與白名單", () => {
  const allow = (cidr: string) => app.db.query(
    "INSERT INTO allowlist_entries VALUES ($1, $2, 'office', 'admin1', $3, NULL)", [randomUUID(), cidr, T0 - DAY]);

  it("白名單無案路徑：E3.A 成立 → 不開案、不上榜，auto_suppressed{allowlist, case_id:null} 一筆；重掃不重寫", async () => {
    await boot();
    await allow("64.0.113.0/24");
    await three(["app-1", "app-2", "app-1"]);
    await tick();
    await hit({ at: T0 - 5 * MIN, app: "app-1", n: 5, port0: 5000 });
    await tick(T0 + 20_000);
    expect([await listed(), await kases()]).toEqual([[], []]);
    expect(await audits("blacklist.auto_suppressed")).toEqual([
      { actor: "system:auto", sensor_id: null, detail: { reason: "allowlist", ip: CIDR, case_id: null } }]);
  });

  it("白名單無案路徑：E3.A 不成立（只有 2 次）→ 不寫 auto_suppressed", async () => {
    await boot();
    await allow("64.0.113.0/24");
    await hit({ at: T0 - 15 * MIN, app: "app-1" });
    await hit({ at: T0 - 5 * MIN, app: "app-2" });
    await tick();
    expect(await audits("blacklist.auto_suppressed")).toEqual([]);
  });

  it("競態：tick 讀完白名單後、上榜前才新增白名單 → 不上榜、auto_suppressed{allowlist} 一筆、案件仍 open", async () => {
    await boot();
    await three(["app-1", "app-2", "app-1"]);
    let calls = 0;
    await tick(T0, { beforeAutoList: async () => { calls += 1; await allow("64.0.113.0/24"); } });
    expect(calls).toBe(1);
    expect(await listed()).toEqual([]);
    const [c] = await kases();
    expect(c!.state).toBe("open");
    expect(await audits("blacklist.auto_suppressed")).toEqual([
      { actor: "system:auto", sensor_id: null, detail: { reason: "allowlist", ip: CIDR, case_id: c!.case_id } }]);
  });

  it("autoListInTx 順序（A 組領航員裁定 11-09 第 2 點）：白名單先於 below_auto → 白名單內且信心未達 auto 回 allowlisted", async () => {
    await boot();
    await allow("64.0.113.0/24");
    expect(await writeAutoBlocklistEntry(app.db, { ip: IP, confidence: 0.5, case_id: randomUUID() }, T0)).toEqual({ status: "allowlisted" });
  });
});

describe("E3.A 冷卻（同一 canonical IP 撤回後 2 小時內不自動上榜）", () => {
  const H = 60 * MIN;
  /** 已撤回的舊項目（SQL 直塞）；revoked_at 相對 T0。 */
  const revoked = (ip: string, source: "auto" | "manual", ago: number) => app.db.query(
    `INSERT INTO blocklist_entries (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at, ended_at)
     VALUES ($1, $2, $3, 1, $4, $5, $6, 'admin1', $5, $7, $7)`,
    [randomUUID(), ip, source, randomUUID(), T0 - 3 * H, T0 + 21 * H, T0 - ago]);
  const active = async () => (await app.db.query<{ ip: string }>("SELECT ip FROM blocklist_entries WHERE ended_at IS NULL")).rows;

  it("auto 項目撤回 1h59m 後 → 不上榜、case 仍 open、auto_suppressed{cooldown, revoked_at}", async () => {
    await boot();
    await revoked(CIDR, "auto", 119 * MIN);
    await three(["app-1", "app-2", "app-1"]);
    await tick();
    const [c] = await kases();
    expect([await active(), c!.state]).toEqual([[], "open"]);
    expect(await audits("blacklist.auto_suppressed")).toEqual([{ actor: "system:auto", sensor_id: null,
      detail: { reason: "cooldown", ip: CIDR, case_id: c!.case_id, revoked_at: new Date(T0 - 119 * MIN).toISOString() } }]);
  });

  it("撤回剛好 2h → 冷卻結束，照常上榜", async () => {
    await boot();
    await revoked(CIDR, "auto", 120 * MIN);
    await three(["app-1", "app-2", "app-1"]);
    await tick();
    expect(await active()).toEqual([{ ip: CIDR }]);
    expect(await audits("blacklist.auto_suppressed")).toEqual([]);
  });

  it("manual 項目撤回也觸發冷卻", async () => {
    await boot();
    await revoked(CIDR, "manual", 30 * MIN);
    await three(["app-1", "app-2", "app-1"]);
    await tick();
    expect(await active()).toEqual([]);
    expect((await audits("blacklist.auto_suppressed")).map((a) => a.detail.reason)).toEqual(["cooldown"]);
  });

  it("涵蓋該 IP 的 /24 剛撤回不算 → 照常上榜", async () => {
    await boot();
    await revoked("64.0.113.0/24", "manual", 30 * MIN);
    await three(["app-1", "app-2", "app-1"]);
    await tick();
    expect(await active()).toEqual([{ ip: CIDR }]);
  });

  it("writeAutoBlocklistEntry（§7 原行為）不受冷卻影響", async () => {
    await boot();
    await revoked(CIDR, "auto", 30 * MIN);
    const r = await writeAutoBlocklistEntry(app.db, { ip: IP, confidence: 0.95, case_id: randomUUID() }, T0);
    expect(r.status).toBe("listed");
  });
});

/** 熔斷測試共用：近 1 小時內已有 n 筆 auto 項目（SQL 直塞，各自不同 IP）。 */
const autos = (n: number, at = T0 - 30 * MIN) => app.db.query(
  `INSERT INTO blocklist_entries (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at)
   SELECT gen_random_uuid(), '64.51.100.' || i || '/32', 'auto', 1, gen_random_uuid(), $2::bigint, $2::bigint + 86400000, 'system:auto', $2::bigint
   FROM generate_series(1, $1::int) AS i`, [n, at]);
const attempt = (ip: string, at = T0) => app.db.tx((q) =>
  autoListInTx(q, { ip, confidence: 1, case_id: randomUUID() }, at, { gates: { breakerPerHour: 50 } }));
/** 鎖等待測試：app 的每條連線帶 lock_timeout 護欄。 */
const guarded = () => ({ databaseUrl: lockGuardedUrl() });
const opened = async () => (await app.db.query<{ opened_at: string | null }>("SELECT opened_at FROM auto_breaker")).rows;

describe("E3.A 熔斷（1 小時內 source=auto ≥ N 筆 → 退回人工審核）", () => {
  const W = { count: 50, limit: 50, window_ms: 3_600_000 };

  it("第 50 筆上榜；第 51 筆擋下並寫一次 auto_breaker_open；第 52 筆不重寫 open", async () => {
    await boot();
    await autos(49);
    expect((await attempt("64.0.113.50")).status).toBe("listed");
    expect((await attempt("64.0.113.51")).status).toBe("breaker");
    expect((await attempt("64.0.113.52")).status).toBe("breaker");
    expect(await audits("blacklist.auto_breaker_open")).toEqual([{ actor: "system:auto", sensor_id: null, detail: W }]);
    expect(await opened()).toEqual([{ opened_at: String(T0) }]);
  });

  it("tick 路徑：熔斷中 E3.A 成立 → auto_suppressed{breaker}、warn、case 仍 open；N 來自 buildApp autoBreakerPerHour", async () => {
    const warns: string[] = [];
    await boot(undefined, { judgeIntervalMs: 20, autoBreakerPerHour: 3, autoListEnabled: true,
      logger: { level: "warn", stream: { write: (l: string) => { warns.push(l); } } } });
    await autos(3);
    await three(["app-1", "app-2", "app-1"]);
    await expect.poll(async () => (await audits("blacklist.auto_suppressed")).length, { timeout: 5_000 }).toBe(1);
    const [c] = await kases();
    expect(c!.state).toBe("open");
    expect((await audits("blacklist.auto_suppressed"))[0]!.detail).toEqual({ reason: "breaker", ip: CIDR, case_id: c!.case_id });
    expect((await audits("blacklist.auto_breaker_open")).map((a) => a.detail)).toEqual([{ count: 3, limit: 3, window_ms: 3_600_000 }]);
    expect(warns.some((l) => l.includes("breaker"))).toBe(true);
  });

  it("視窗過了：tick 在 AUTO_LOCK 下補判一次 → auto_breaker_close 只寫一次；之後照常上榜", async () => {
    await boot();
    await autos(50);
    expect((await attempt("64.0.113.51")).status).toBe("breaker");
    await tick(T0 + 31 * MIN);
    await tick(T0 + 32 * MIN);
    expect(await audits("blacklist.auto_breaker_close")).toEqual([{ actor: "system:auto", sensor_id: null, detail: { count: 0, limit: 50 } }]);
    expect(await opened()).toEqual([{ opened_at: null }]);
    expect((await attempt("64.0.113.53", T0 + 33 * MIN)).status).toBe("listed");
    expect(await audits("blacklist.auto_breaker_close")).toHaveLength(1);
  });

  it("autoListInTx 嘗試時也判恢復：開著但已低於 N → 寫 close 一次並上榜", async () => {
    await boot();
    await autos(50);
    expect((await attempt("64.0.113.51")).status).toBe("breaker");
    expect((await attempt("64.0.113.52", T0 + 31 * MIN)).status).toBe("listed");
    expect((await audits("blacklist.auto_breaker_close")).map((a) => a.detail)).toEqual([{ count: 0, limit: 50 }]);
  });

});

describe("E3.A 熔斷：AUTO_LOCK 序列化與 auto_breaker 單列", () => {
  it("已有 49 筆、兩個並行嘗試 → AUTO_LOCK 序列化，只有一筆上榜", async () => {
    await boot(undefined, guarded());
    await autos(49);
    let firstDone!: () => void;
    const gate = new Promise<void>((r) => { firstDone = r; });
    const waiting = async () => (await app.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0]!.n;
    const a = app.db.tx(async (q) => {
      const r = await autoListInTx(q, { ip: "64.0.113.60", confidence: 1, case_id: randomUUID() }, T0, { gates: { breakerPerHour: 50 } });
      firstDone();
      for (let i = 0; i < 100 && (await waiting()) === "0"; i += 1) await new Promise((res) => setTimeout(res, 20));
      return r;
    });
    await gate;
    const b = attempt("64.0.113.61");
    expect([(await a).status, (await b).status]).toEqual(["listed", "breaker"]);
  }, LOCK_TEST_TIMEOUT_MS);

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("autoBreakerPerHour=%s（非正整數）→ buildApp 啟動即拋錯", async (n) => {
    await expect(buildApp({ databaseUrl: requireDatabaseUrl(), logger: false, judgeIntervalMs: 0, autoBreakerPerHour: n }))
      .rejects.toThrow(/autoBreakerPerHour/);
  });

  it("auto_breaker 單列：重複 init 不加列；id 只能是 TRUE", async () => {
    await boot();
    const again = await buildApp({ databaseUrl: requireDatabaseUrl(), logger: false, judgeIntervalMs: 0 });
    await again.close();
    expect(await opened()).toHaveLength(1);
    await expect(app.db.query("INSERT INTO auto_breaker (id) VALUES (FALSE)")).rejects.toMatchObject({ code: "23514" });
    await expect(app.db.query("INSERT INTO auto_breaker (id) VALUES (TRUE)")).rejects.toMatchObject({ code: "23505" });
  });
});

describe("自動上榜路徑只吞 data exception：其他錯誤讓整個 tick rollback、cursor 不動（A 組領航員裁定）", () => {
  const cursor = async () => (await app.db.query<{ received_upto: string }>("SELECT received_upto FROM judge_cursor")).rows;
  /** 測試專用 trigger：寫 blocklist_entries（autoListInTx 的 insert）時丟指定 SQLSTATE。 */
  const trap = (code: string) => app.db.exec(`
    CREATE OR REPLACE FUNCTION test_trap_bl() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'trap' USING ERRCODE = '${code}'; END $$;
    CREATE TRIGGER test_trap_bl BEFORE INSERT ON blocklist_entries FOR EACH ROW EXECUTE FUNCTION test_trap_bl();`);
  const untrap = () => app.db.exec("DROP TRIGGER test_trap_bl ON blocklist_entries; DROP FUNCTION test_trap_bl()");
  const rolledBack = async () => {
    expect(await cursor()).toEqual([]);
    expect([await listed(), await kases(), await audits("blacklist.auto_list")]).toEqual([[], [], []]);
    expect((await app.db.query("SELECT 1 FROM case_hits")).rows).toEqual([]);
  };

  it.each(["55P03", "40P01", "P0001"])("insert 時丟 %s → tick reject、命中／案件／cursor 全部 rollback；移除後下一個 tick 上榜", async (code) => {
    await boot();
    await three(["app-1", "app-2", "app-1"]);
    await trap(code);
    await expect(tick()).rejects.toMatchObject({ code });
    await rolledBack();
    await untrap();
    await tick(T0 + 1000);
    expect((await listed()).map((e) => e.ip)).toEqual([CIDR]);
  });

  it("沒有 SQLSTATE 的錯誤（上榜前丟 Error）→ tick reject、全部 rollback", async () => {
    await boot();
    await three(["app-1", "app-2", "app-1"]);
    await expect(tick(T0, { beforeAutoList: () => Promise.reject(new Error("boom")) })).rejects.toThrow("boom");
    await rolledBack();
  });
});

describe("白名單 SHARE 鎖與鎖順序（A 覆核）", () => {
  it("SHARE 鎖：上榜前另一連線有未 commit 的白名單新增 → tick 等它 commit、重查 → auto_suppressed{allowlist}、不上榜", async () => {
    await boot(undefined, guarded());
    await three(["app-1", "app-2", "app-1"]);
    let waiter: number | null = null;
    let bg: Promise<void> = Promise.resolve();
    await tick(T0, { beforeAutoList: async () => {
      const hold = await holdAllowlistInsert("64.0.113.0/24", T0 - DAY);
      bg = (async () => { waiter = await waitShareWaiter(app.db); await hold.commit(); })();
    } });
    await bg;
    expect(waiter).not.toBeNull();
    expect(await listed()).toEqual([]);
    expect((await audits("blacklist.auto_suppressed")).map((a) => a.detail.reason)).toEqual(["allowlist"]);
  }, LOCK_TEST_TIMEOUT_MS);

  it("鎖順序 SHARE → AUTO_LOCK：熔斷開著時 tick 的恢復判定也先等 SHARE，等的當下不持有 AUTO_LOCK", async () => {
    await boot(undefined, guarded());
    await autos(50, T0 - 90 * MIN);
    await app.db.query("UPDATE auto_breaker SET opened_at = $1 WHERE id", [T0 - 70 * MIN]);
    await three(["app-1", "app-2", "app-1"]);
    const hold = await holdAllowlistInsert("64.0.2.0/24", T0 - DAY);
    const running = tick();
    const pid = await waitShareWaiter(app.db);
    const heldAuto = pid !== null && (await holdsAdvisory(app.db, pid, AUTO_LOCK));
    await hold.commit();
    await running;
    expect([pid !== null, heldAuto]).toEqual([true, false]);
    expect((await listed()).map((e) => e.ip)).toContain(CIDR);
  }, LOCK_TEST_TIMEOUT_MS);
});

describe("R19：被熔斷擋下的高嚴重命中，熔斷恢復後重掃不得補上榜；新的高嚴重命中才上榜（isNewHigh）", () => {
  const mine = async () => (await listed()).filter((e) => e.ip === CIDR);

  it("熔斷開 → E3.A 成立被擋；恢復後同一批命中重掃（重疊區）→ 不上榜；之後新的高嚴重命中 → 上榜", async () => {
    await boot();
    await autos(50, T0 - 59 * MIN);
    await three(["app-1", "app-2", "app-1"]);
    await tick();
    expect((await audits("blacklist.auto_suppressed")).map((a) => a.detail.reason)).toEqual(["breaker"]);
    await tick(T0 + 2 * MIN);
    expect(await opened()).toEqual([{ opened_at: null }]);
    expect(await mine()).toEqual([]);
    expect((await kases()).map((c) => c.state)).toEqual(["open"]);
    await hit({ at: T0, app: "app-2" });
    await tick(T0 + 3 * MIN);
    expect((await mine()).map((e) => e.source)).toEqual(["auto"]);
  });
});

describe("auto_suppressed 去重：同一 (ip, reason) 每小時最多一筆，多出來的每個 tick 一行 log 記數量（A 覆核）", () => {
  let lines: string[] = [];
  const log = { warn: (obj: object, msg: string) => { lines.push(JSON.stringify({ ...obj, msg })); }, error: (obj: object, msg: string) => { lines.push(JSON.stringify({ ...obj, msg })); } };
  const suppressed = async () => (await audits("blacklist.auto_suppressed")).map((a) => a.detail.reason);
  const more = (at: number) => hit({ at, app: "app-2", port0: 7000 });

  it("白名單無案：1 小時內第二次 E3.A 成立不再寫、log {deduped:1} 不帶 IP；滿 1 小時後再寫", async () => {
    await boot();
    lines = [];
    await app.db.query("INSERT INTO allowlist_entries VALUES ($1, '64.0.113.0/24', 'office', 'admin1', $2, NULL)", [randomUUID(), T0 - DAY]);
    await three(["app-1", "app-2", "app-1"]);
    await runJudgeTick(app.db, T0, log, ON);
    await more(T0);
    await runJudgeTick(app.db, T0 + 6 * MIN, log, ON);
    expect(await suppressed()).toEqual(["allowlist"]);
    expect(lines.map((l) => JSON.parse(l) as object)).toEqual([
      { deduped: 1, msg: "judge tick deduped auto_suppressed audits (1 per ip+reason per hour)" }]);
    expect(lines.join("\n")).not.toContain("64.0.113");
    for (const off of [40, 50, 60]) await hit({ at: T0 + off * MIN, app: off === 50 ? "app-2" : "app-1" });
    await runJudgeTick(app.db, T0 + 66 * MIN, log, ON);
    expect(await suppressed()).toEqual(["allowlist", "allowlist"]);
  });

  it("有案（熔斷）：1 小時內第二次被熔斷擋下不再寫 auto_suppressed{breaker}", async () => {
    await boot();
    await autos(50);
    await three(["app-1", "app-2", "app-1"]);
    await tick();
    await more(T0);
    await tick(T0 + 6 * MIN);
    expect(await suppressed()).toEqual(["breaker"]);
  });

  it("partial index audit_auto_suppressed_ip_reason 已建立；重複初始化不報錯", async () => {
    await boot();
    expect(await auditIndexDefAfterReinit(app, "audit_auto_suppressed_ip_reason")).toMatch(/\(action, \(\(detail ->> 'ip'::text\)\), \(\(detail ->> 'reason'::text\)\), at\) WHERE \(action = 'blacklist\.auto_suppressed'::text\)/);
  });
});

describe("熔斷滑動視窗邊界（created_at > now − 1h）", () => {
  it("50 筆 auto 恰好建立於 1 小時前 → 不計入，第 51 次嘗試照常上榜", async () => {
    await boot();
    await autos(50, T0 - 60 * MIN);
    expect((await attempt("64.0.113.70")).status).toBe("listed");
  });

  it("50 筆 auto 建立於 1 小時前 + 1ms → 計入，第 51 次嘗試被熔斷", async () => {
    await boot();
    await autos(50, T0 - 60 * MIN + 1);
    expect((await attempt("64.0.113.71")).status).toBe("breaker");
  });
});

describe("B5：非公網位址不自動上榜（auto_suppressed{non_public}，同 (ip, reason) 每小時去重；案件留在待審）", () => {
  const NON_PUBLIC = ["10.0.0.53", "172.16.0.1", "192.168.1.1", "100.64.0.1", "fc00::1"];

  it.each(NON_PUBLIC)("autoListInTx(%s) → not_public，不寫入", async (ip) => {
    await boot();
    expect((await attempt(ip)).status).toBe("not_public");
    expect(await listed()).toEqual([]);
  });

  it("公網 IP 照常上榜", async () => {
    await boot();
    expect((await attempt("64.0.113.80")).status).toBe("listed");
  });

  it("tick：非公網 IP E3.A 成立 → 不上榜、案件仍 open、auto_suppressed{non_public} 一筆；1 小時內再成立不重寫", async () => {
    await boot();
    for (const [off, a] of [[25, "app-1"], [15, "app-2"], [5, "app-1"]] as const) await hit({ at: T0 - off * MIN, app: a, ip: "10.0.0.53" });
    await tick();
    await hit({ at: T0, app: "app-2", ip: "10.0.0.53", port0: 7000 });
    await tick(T0 + 6 * MIN);
    expect(await listed()).toEqual([]);
    const [c] = await kases();
    expect(c).toMatchObject({ ip: "10.0.0.53/32", state: "open" });
    expect((await audits("blacklist.auto_suppressed")).map((a) => a.detail)).toEqual([
      { reason: "non_public", ip: "10.0.0.53/32", case_id: c!.case_id }]);
  });
});

describe("鎖等待測試護欄（資安 low）：等鎖的連線設 lock_timeout，測試另設 vitest timeout", () => {
  it("lockGuardedUrl 連上的 app：lock_timeout = LOCK_TIMEOUT_MS；測試 timeout 大於兩倍 lock_timeout", async () => {
    await boot(undefined, guarded());
    const show = async (q: { query: <T>(s: string) => Promise<{ rows: T[] }> }) =>
      (await q.query<{ lock_timeout: string }>("SHOW lock_timeout")).rows[0]!.lock_timeout;
    expect(await show(app.db)).toBe(`${LOCK_TIMEOUT_MS / 1000}s`);
    expect(LOCK_TEST_TIMEOUT_MS).toBeGreaterThan(LOCK_TIMEOUT_MS * 2);
  });
});

describe("autoListEnabled（總開關，預設關）：關時 tick 完全不做自動上榜", () => {
  it("預設值是唯一匯出常數 AUTO_LIST_ENABLED_DEFAULT = false", () => {
    expect(AUTO_LIST_ENABLED_DEFAULT).toBe(false);
  });

  it("未指定（預設關）：E3.A 成立、白名單、熔斷都一樣 → 不上榜、案件留待審、不寫任何上榜相關稽核", async () => {
    await boot();
    await autos(50, T0 - 90 * MIN);
    await app.db.query("UPDATE auto_breaker SET opened_at = $1 WHERE id", [T0 - 70 * MIN]);
    await three(["app-1", "app-2", "app-1"]);
    for (const [off, a] of [[25, "app-1"], [15, "app-2"], [5, "app-1"]] as const) await hit({ at: T0 - off * MIN, app: a, ip: "64.0.2.9" });
    await app.db.query("INSERT INTO allowlist_entries VALUES ($1, '64.0.2.0/24', 'office', 'admin1', $2, NULL)", [randomUUID(), T0 - DAY]);
    await runJudgeTick(app.db, T0);
    expect((await listed()).filter((e) => !e.ip.startsWith("64.51.100."))).toEqual([]);
    expect((await kases()).map((c) => [c.ip, c.state])).toEqual([[CIDR, "open"]]);
    for (const a of ["blacklist.auto_list", "blacklist.auto_suppressed", "blacklist.auto_breaker_open", "blacklist.auto_breaker_close"]) {
      expect(await audits(a)).toEqual([]);
    }
    expect(await opened()).toEqual([{ opened_at: String(T0 - 70 * MIN) }]);
  });

  it("關閉時凍結熔斷：已可恢復也不寫 auto_breaker_close、狀態不變；重新開啟後第一個 tick 照常補判恢復", async () => {
    await boot();
    await autos(50);
    expect((await attempt("64.0.113.51")).status).toBe("breaker");
    const frozen = await opened();
    expect(frozen).not.toEqual([{ opened_at: null }]);
    await tick(T0 + 31 * MIN, { autoListEnabled: false }); // 視窗已過、可恢復，但總開關關
    expect([await audits("blacklist.auto_breaker_close"), await opened()]).toEqual([[], frozen]);
    await tick(T0 + 32 * MIN); // 重新開啟（ON）
    expect(await audits("blacklist.auto_breaker_close")).toEqual([{ actor: "system:auto", sensor_id: null, detail: { count: 0, limit: 50 } }]);
    expect(await opened()).toEqual([{ opened_at: null }]);
  });

  it("buildApp 排程（預設關）：E3.A 成立 → 案件留待審、不上榜", async () => {
    await boot(undefined, { judgeIntervalMs: 20 });
    await app.db.query("DELETE FROM judge_cursor"); // 前一個測試的 cursor 會跳過本測試較早收到的列
    // 排程在 boot 重建 fixtures 前就可能先跑，前一個測試的列／命中會混進來：本測試用沒人用過的 IP
    const ip = "64.0.113.77";
    for (const [off, a] of [[25, "app-1"], [15, "app-2"], [5, "app-1"]] as const) await hit({ at: T0 - off * MIN, app: a, ip });
    const mine = async () => (await kases()).filter((c) => c.ip === `${ip}/32`);
    const judged = async () => (await app.db.query("SELECT 1 FROM case_hits WHERE src_ip = $1", [`${ip}/32`])).rows.length;
    await expect.poll(judged, { timeout: 5_000 }).toBe(3);
    await new Promise((r) => setTimeout(r, 100));
    expect([await listed(), (await mine()).map((c) => c.state)]).toEqual([[], ["open"]]);
  });
});
