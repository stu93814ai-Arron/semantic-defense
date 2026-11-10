import { afterEach, describe, expect, it } from "vitest";
import { insertFlowEvents, insertLegacyFlowEvents } from "@semantic-defense/flow-store/testing";
import type { ControlApi } from "./helpers/app.js";
import { MIN, T0, bootJudgeApp, flowEvent as flow } from "./helpers/judge.js";
import { PENDING_BACKFILL_MAX_LAG_MS, runJudgeTick } from "../src/judge.js";

/** B1：回填已結束後才出現的可轉換 NULL 列，超過 lag 上限則略過，避免永久卡住判定。 */
let app: ControlApi;
const warns: string[] = [];
const errors: string[] = [];
afterEach(async () => { if (app) await app.close(); });

const PENDING_MSG = "judge tick pending backfill";
const STALE_MSG = "judge tick skipped stale pending backfill";
const ATTACK = "64.0.113.99";
const OLD_IP = "198.51.99.9";
const log = {
  warn: (obj: object, msg: string) => { warns.push(JSON.stringify({ ...obj, msg })); },
  error: (obj: object, msg: string) => { errors.push(JSON.stringify({ ...obj, msg })); },
};
const parsed = (lines: string[]) => lines.map((l) => JSON.parse(l) as object);
const cursor = async () => (await app.db.query<{ received_upto: string }>("SELECT received_upto FROM judge_cursor")).rows;
const openIps = async () => (await app.db.query<{ ip: string }>("SELECT ip FROM blacklist_cases WHERE state = 'open'")).rows;
const resetLogs = () => { warns.length = 0; errors.length = 0; };
const noSecret = (lines: string[]) => {
  const text = lines.join("\n");
  for (const s of [ATTACK, OLD_IP, "64.0.113", "198.51.", "2026-"]) expect(text).not.toContain(s);
};

const attack = (receivedAt: number) => Array.from({ length: 30 }, (_, i) => ({
  flow: flow(ATTACK, T0 - 2 * MIN, 1000 + i, true), sensorId: "s-1", receivedAt,
}));
const leftover = (receivedAt: number, n = 1) => Array.from({ length: n }, (_, i) => ({
  flow: flow(OLD_IP, receivedAt - MIN, 2000 + i, true), sensorId: "s-9", receivedAt,
}));

describe("PENDING_BACKFILL_MAX_LAG_MS", () => {
  it("為 10 分鐘", () => { expect(PENDING_BACKFILL_MAX_LAG_MS).toBe(10 * MIN); });
});

describe("資安 stall repro：回填結束後才到的可轉換 NULL", () => {
  it("超過 lag 上限時略過該列、cursor 前進，20 個 tick 後攻擊流量仍開案，error 不含 IP", async () => {
    app = await bootJudgeApp();
    resetLogs();
    // 回填已在 boot 完成；再插入一筆舊 ingest／restore 的可轉換 NULL（T0-50min），以及 T0-1min 的攻擊流量
    expect(await insertLegacyFlowEvents(app.db, leftover(T0 - 50 * MIN))).toBe(1);
    expect(await insertFlowEvents(app.db, attack(T0 - MIN))).toBe(30);
    for (let i = 0; i < 20; i++) await runJudgeTick(app.db, T0 + i * MIN, log);
    await expect(openIps()).resolves.toEqual([{ ip: `${ATTACK}/32` }]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - MIN) }]);
    expect(parsed(errors)).toEqual([{ stale_pending: 1, msg: STALE_MSG }]);
    expect(parsed(warns).filter((l) => "pending_backfill" in l)).toEqual([]);
    noSecret([...warns, ...errors]);
  });

  it("在上限內仍停 cursor、不對後到的攻擊流量開案", async () => {
    app = await bootJudgeApp();
    resetLogs();
    expect(await insertLegacyFlowEvents(app.db, leftover(T0 - 5 * MIN))).toBe(1);
    expect(await insertFlowEvents(app.db, attack(T0 - MIN))).toBe(30);
    await expect(runJudgeTick(app.db, T0, log)).resolves.toMatchObject({ ran: true, hits: 0, groups: 0 });
    expect(await openIps()).toEqual([]);
    expect(await cursor()).toEqual([]);
    expect(parsed(warns)).toEqual([{ pending_backfill: 1, msg: PENDING_MSG }]);
    expect(errors).toEqual([]);
  });
});

describe("stale_pending 計數", () => {
  it("多筆超過上限的待回填列都計入 stale_pending", async () => {
    app = await bootJudgeApp();
    resetLogs();
    expect(await insertLegacyFlowEvents(app.db, leftover(T0 - 50 * MIN, 2))).toBe(2);
    expect(await insertFlowEvents(app.db, attack(T0 - MIN))).toBe(30);
    await runJudgeTick(app.db, T0, log);
    expect(parsed(errors)).toEqual([{ stale_pending: 2, msg: STALE_MSG }]);
    expect(await openIps()).toEqual([{ ip: `${ATTACK}/32` }]);
    noSecret(errors);
  });
});
