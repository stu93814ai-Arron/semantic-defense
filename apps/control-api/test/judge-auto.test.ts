import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { insertFlowEvents } from "@semantic-defense/flow-store/testing";
import type { ControlApi } from "./helpers/app.js";
import { DAY, MIN, T0, bootJudgeApp, flowEvent } from "./helpers/judge.js";
import { runJudgeTick, type TickHooks } from "../src/judge.js";
import { writeAutoBlocklistEntry } from "../src/auto-blacklist.js";

/**
 * 成案流程 commit 9：E3.A 自動上榜條件（計畫 §1 步驟 4、§6.1、§7；A 裁定 11-09）。
 * 30 分鐘內 ≥3 次高嚴重命中（ontime_confidence ≥ auto），且 ≥2 個已綁定的 app_id 或 sensor_id。
 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const IP = "203.0.113.20";
const CIDR = `${IP}/32`;
async function boot(tokens: Record<string, string[]> = { "s-1": ["app-1", "app-2"], "s-2": ["app-1", "app-2"] }) {
  app = await bootJudgeApp();
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
const tick = (at = T0, hooks: TickHooks = {}) => runJudgeTick(app.db, at, undefined, hooks);
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
    await allow("203.0.113.0/24");
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
    await allow("203.0.113.0/24");
    await hit({ at: T0 - 15 * MIN, app: "app-1" });
    await hit({ at: T0 - 5 * MIN, app: "app-2" });
    await tick();
    expect(await audits("blacklist.auto_suppressed")).toEqual([]);
  });

  it("競態：tick 讀完白名單後、上榜前才新增白名單 → 不上榜、auto_suppressed{allowlist} 一筆、案件仍 open", async () => {
    await boot();
    await three(["app-1", "app-2", "app-1"]);
    let calls = 0;
    await tick(T0, { beforeAutoList: async () => { calls += 1; await allow("203.0.113.0/24"); } });
    expect(calls).toBe(1);
    expect(await listed()).toEqual([]);
    const [c] = await kases();
    expect(c!.state).toBe("open");
    expect(await audits("blacklist.auto_suppressed")).toEqual([
      { actor: "system:auto", sensor_id: null, detail: { reason: "allowlist", ip: CIDR, case_id: c!.case_id } }]);
  });

  it("autoListInTx 順序（A 裁定 11-09 第 2 點）：白名單先於 below_auto → 白名單內且信心未達 auto 回 allowlisted", async () => {
    await boot();
    await allow("203.0.113.0/24");
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
    await revoked("203.0.113.0/24", "manual", 30 * MIN);
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
