import { afterEach, describe, expect, it } from "vitest";
import { insertFlowEvents, insertLegacyFlowEvents } from "@semantic-defense/flow-store/testing";
import type { ControlApi } from "./helpers/app.js";
import { buildApp } from "./helpers/app.js";
import { requireLoginCookie } from "./helpers/boot-fixtures.js";
import { cookieHeader } from "./helpers/session.js";
import { MIN, T0, bootJudgeApp, flowEvent as flow } from "./helpers/judge.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { PENDING_BACKFILL_MAX_LAG_MS } from "../src/judge.js";
import {
  DEFAULT_CURSOR_LAG_MS, DEFAULT_TICK_FAIL_ALERT_N, applyJudgeAlerts, judgeHealthCounts,
  parseJudgeAlertConfig, runJudgeTickWithAlerts, type JudgeAlertConfig,
} from "../src/judge-alerts.js";

/** 資安提出 R16 驗收：tick 連敗與 cursor 落後告警；N 預設 3 為 A 組領航員建議。 */
let app: ControlApi;
afterEach(async () => {
  if (app) { await app.close(); app = undefined as unknown as ControlApi; }
  delete process.env.SD_JUDGE_TICK_FAIL_ALERT_N;
  delete process.env.SD_JUDGE_CURSOR_LAG_MS;
});

const CFG: JudgeAlertConfig = { failN: 3, lagMs: PENDING_BACKFILL_MAX_LAG_MS };
const CH = ["webhook"] as const;
const NOW = T0;

const kinds = async () => (await app.db.query<{ kind: string; payload: Record<string, unknown> }>(
  "SELECT kind, payload FROM alert_outbox ORDER BY created_at, id")).rows;

const payloadKeys = (p: Record<string, unknown>) => Object.keys(p).sort();

async function boot(): Promise<ControlApi> {
  app = await bootJudgeApp({ logger: false, judgeIntervalMs: 0, alertChannels: [...CH] });
  return app;
}

async function apply(outcome: "success" | "failure" | "noop", extra: { stalePending?: number } = {}) {
  await applyJudgeAlerts(app.db, { now: NOW, channels: CH, cfg: CFG, outcome, ...extra });
}

async function healthHttp() {
  const cookie = await requireLoginCookie(app, "admin1", "pass-admin-1");
  const res = await app.inject({ method: "GET", url: "/api/health", headers: cookieHeader(cookie) });
  expect(res.statusCode).toBe(200);
  return res.json() as { status: string; alerts: unknown; judge?: Record<string, unknown> };
}

describe("parseJudgeAlertConfig", () => {
  it("未設定時 N 預設 3、落後門檻預設 10 分鐘", () => {
    expect(DEFAULT_TICK_FAIL_ALERT_N).toBe(3);
    expect(DEFAULT_CURSOR_LAG_MS).toBe(10 * MIN);
    expect(parseJudgeAlertConfig({})).toEqual({ failN: 3, lagMs: 10 * MIN });
  });

  it("N 只接受 3–5 的整數；落後門檻須為正整數", () => {
    expect(parseJudgeAlertConfig({ SD_JUDGE_TICK_FAIL_ALERT_N: "4" }).failN).toBe(4);
    expect(parseJudgeAlertConfig({ SD_JUDGE_TICK_FAIL_ALERT_N: "5" }).failN).toBe(5);
    expect(() => parseJudgeAlertConfig({ SD_JUDGE_TICK_FAIL_ALERT_N: "2" })).toThrow(/SD_JUDGE_TICK_FAIL_ALERT_N/);
    expect(() => parseJudgeAlertConfig({ SD_JUDGE_TICK_FAIL_ALERT_N: "6" })).toThrow(/SD_JUDGE_TICK_FAIL_ALERT_N/);
    expect(() => parseJudgeAlertConfig({ SD_JUDGE_TICK_FAIL_ALERT_N: "3.5" })).toThrow(/SD_JUDGE_TICK_FAIL_ALERT_N/);
    expect(() => parseJudgeAlertConfig({ SD_JUDGE_CURSOR_LAG_MS: "0" })).toThrow(/SD_JUDGE_CURSOR_LAG_MS/);
    expect(() => parseJudgeAlertConfig({ SD_JUDGE_CURSOR_LAG_MS: "-1" })).toThrow(/SD_JUDGE_CURSOR_LAG_MS/);
    expect(parseJudgeAlertConfig({ SD_JUDGE_CURSOR_LAG_MS: "1000" }).lagMs).toBe(1000);
  });

  it("buildApp 在啟動時就驗證，即使 judgeIntervalMs 為 0", async () => {
    process.env.SD_JUDGE_TICK_FAIL_ALERT_N = "2";
    await expect(buildApp({ databaseUrl: requireDatabaseUrl(), logger: false, judgeIntervalMs: 0 }))
      .rejects.toThrow(/SD_JUDGE_TICK_FAIL_ALERT_N/);
  });
});

describe("tick 連敗告警", () => {
  it("N−1 次失敗不告警，第 N 次才入列一筆；payload 只含 kind、數字與時間", async () => {
    await boot();
    await apply("failure");
    await apply("failure");
    expect(await kinds()).toEqual([]);
    await apply("failure");
    const rows = await kinds();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("tick_fail");
    expect(rows[0]!.payload.kind).toBe("tick_fail");
    expect(rows[0]!.payload.streak).toBe(3);
    expect(rows[0]!.payload.at).toBe(NOW);
    expect(payloadKeys(rows[0]!.payload)).toEqual(["at", "delivery_id", "kind", "streak"]);
    await apply("failure");
    expect(await kinds()).toHaveLength(1);
  });

  it("恢復後連敗計數歸零，新一輪第 N 次再告警", async () => {
    await boot();
    await apply("failure");
    await apply("failure");
    await apply("success");
    expect(await kinds()).toEqual([]);
    await apply("failure");
    await apply("failure");
    expect(await kinds()).toEqual([]);
    await apply("failure");
    expect((await kinds()).map((r) => r.kind)).toEqual(["tick_fail"]);
  });

  it("NOOP 不增加也不重設連敗；無通道時不寫 outbox，health 仍更新", async () => {
    await boot();
    await apply("failure");
    await apply("noop");
    await applyJudgeAlerts(app.db, { now: NOW, channels: [], cfg: CFG, outcome: "failure" });
    expect(await kinds()).toEqual([]);
    const h = await judgeHealthCounts(app.db);
    expect(h.tick_fail_streak).toBe(2);
    await applyJudgeAlerts(app.db, { now: NOW, channels: [], cfg: CFG, outcome: "failure" });
    expect(await kinds()).toEqual([]);
    expect((await judgeHealthCounts(app.db)).tick_fail_streak).toBe(3);
  });
});

describe("cursor 落後與 stale_pending 告警", () => {
  it("落後超過門檻才告警；等於門檻不告警；同一段落後只告一次", async () => {
    await boot();
    await app.db.query(
      "INSERT INTO judge_cursor (id, received_upto) VALUES (TRUE, $1) ON CONFLICT (id) DO UPDATE SET received_upto = $1",
      [T0],
    );
    expect(await insertFlowEvents(app.db, [
      { flow: flow("203.0.113.10", T0, 80, false), sensorId: "s-1", receivedAt: T0 + CFG.lagMs },
    ])).toBe(1);
    await apply("success");
    expect(await kinds()).toEqual([]);
    await app.db.query("UPDATE flow_events SET received_at = $1", [T0 + CFG.lagMs + 1]);
    await apply("success");
    const first = await kinds();
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("cursor_lag");
    expect(first[0]!.payload.lag_ms).toBe(CFG.lagMs + 1);
    expect(payloadKeys(first[0]!.payload)).toEqual(["at", "delivery_id", "kind", "lag_ms"]);
    await apply("success");
    expect(await kinds()).toHaveLength(1);
    await app.db.query("UPDATE flow_events SET received_at = $1", [T0]);
    await apply("success");
    expect(await kinds()).toHaveLength(1);
    await app.db.query("UPDATE flow_events SET received_at = $1", [T0 + CFG.lagMs + 5]);
    await apply("success");
    expect((await kinds()).map((r) => r.kind)).toEqual(["cursor_lag", "cursor_lag"]);
  });

  it("cursor 落後恰好等於門檻不告警，超過 1ms 才告警", async () => {
    await boot();
    await app.db.query(
      "INSERT INTO judge_cursor (id, received_upto) VALUES (TRUE, $1) ON CONFLICT (id) DO UPDATE SET received_upto = $1",
      [T0],
    );
    expect(await insertFlowEvents(app.db, [
      { flow: flow("203.0.113.10", T0, 80, false), sensorId: "s-1", receivedAt: T0 + CFG.lagMs },
    ])).toBe(1);
    await apply("success");
    expect(await kinds()).toEqual([]);
    await app.db.query("UPDATE flow_events SET received_at = $1", [T0 + CFG.lagMs + 1]);
    await apply("success");
    const rows = await kinds();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("cursor_lag");
    expect(rows[0]!.payload.lag_ms).toBe(CFG.lagMs + 1);
  });

  it("stale_pending 發生時入列一筆且只帶筆數；health 含三個欄位", async () => {
    await boot();
    const leftover = Array.from({ length: 2 }, (_, i) => ({
      flow: flow("198.51.100.9", T0 - 50 * MIN, 2000 + i, true), sensorId: "s-9", receivedAt: T0 - 50 * MIN,
    }));
    const attack = Array.from({ length: 30 }, (_, i) => ({
      flow: flow("203.0.113.99", T0 - MIN, 1000 + i, true), sensorId: "s-1", receivedAt: T0 - MIN,
    }));
    expect(await insertLegacyFlowEvents(app.db, leftover)).toBe(2);
    expect(await insertFlowEvents(app.db, attack)).toBe(30);
    const r = await runJudgeTickWithAlerts(app.db, T0, undefined, { alertChannels: CH }, CFG);
    expect(r.ran).toBe(true);
    expect(r.stalePending).toBe(2);
    const rows = (await kinds()).filter((x) => x.kind === "stale_pending");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.stale_pending).toBe(2);
    expect(payloadKeys(rows[0]!.payload)).toEqual(["at", "delivery_id", "kind", "stale_pending"]);
    const h = await healthHttp();
    expect(h.status).toBe("ok");
    expect(h.judge).toMatchObject({ tick_fail_streak: 0, stale_pending_total: 2 });
    expect(h.judge?.cursor_lag_seconds).toEqual(expect.any(Number));
    expect(JSON.stringify(h.judge)).not.toMatch(/203\.0\.|198\.51\.|SELECT |ERROR:/i);
  });
});
