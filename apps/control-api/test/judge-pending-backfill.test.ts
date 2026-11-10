import { afterEach, describe, expect, it } from "vitest";
import { insertFlowEvents, insertLegacyFlowEvents } from "@semantic-defense/flow-store/testing";
import type { ControlApi } from "./helpers/app.js";
import { MIN, T0, bootJudgeApp, flowEvent as flow } from "./helpers/judge.js";
import { runJudgeTick } from "../src/judge.js";

/** R-B：可轉換但尚未回填的 NULL 列不得被 cursor 越過；毒列維持略過並前進。 */
let app: ControlApi;
let lines: string[] = [];
afterEach(async () => { if (app) await app.close(); });

const PENDING_MSG = "judge tick pending backfill";
const NULL_TS_MSG = "judge tick skipped rows without ts_ms";
const IP = "203.0.113.21";
const POISON_TS = "0000-01-01T00:00:00Z";
const log = { warn: (obj: object, msg: string) => { lines.push(JSON.stringify({ ...obj, msg })); } };
const logged = () => lines.map((l) => JSON.parse(l) as object);
const cursor = async () => (await app.db.query<{ received_upto: string }>("SELECT received_upto FROM judge_cursor")).rows;
const cases = async () => (await app.db.query<{ ip: string }>("SELECT ip FROM blacklist_cases WHERE state = 'open'")).rows;

const susp = (n: number, receivedAt: number, ts = T0 - 2 * MIN) => Array.from({ length: n }, (_, i) => ({
  flow: flow(IP, ts, 1000 + i, true), sensorId: "s-1", receivedAt,
}));

describe("待回填的可轉換 NULL：cursor 停在該列之前（R-B）", () => {
  it("回填期間，可轉換的 NULL 列不會被略過（cursor 不越過、不計入 null_ts）", async () => {
    app = await bootJudgeApp();
    lines = [];
    expect(await insertLegacyFlowEvents(app.db, susp(30, T0 - MIN))).toBe(30);
    await expect(runJudgeTick(app.db, T0, log)).resolves.toMatchObject({ ran: true, hits: 0, groups: 0 });
    expect(await cases()).toEqual([]);
    expect(await cursor()).toEqual([]);
    expect(logged()).toEqual([{ pending_backfill: 30, msg: PENDING_MSG }]);
    for (const s of [IP, "203.0.113", "2026-"]) expect(lines.join("\n")).not.toContain(s);
  });

  it("回填後（補上 ts_ms）照常判定分組", async () => {
    app = await bootJudgeApp();
    lines = [];
    expect(await insertLegacyFlowEvents(app.db, susp(30, T0 - MIN))).toBe(30);
    await runJudgeTick(app.db, T0, log);
    expect(await cases()).toEqual([]);
    expect(await cursor()).toEqual([]);
    await app.db.query("UPDATE flow_events SET ts_ms = flow_ts_ms(ts) WHERE ts_ms IS NULL");
    lines = [];
    await expect(runJudgeTick(app.db, T0, log)).resolves.toMatchObject({ ran: true, hits: 1, groups: 1 });
    expect(await cases()).toEqual([{ ip: "203.0.113.21/32" }]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - MIN) }]);
    expect(logged()).toEqual([]);
  });

  it("毒列仍讓 cursor 前進並計入 null_ts", async () => {
    app = await bootJudgeApp();
    lines = [];
    expect(await insertLegacyFlowEvents(app.db, Array.from({ length: 3 }, (_, i) => ({
      flow: { ...flow("198.51.100.21", T0 - 2 * MIN, 1000 + i, true), ts: POISON_TS },
      sensorId: "s-1", receivedAt: T0 - MIN,
    })))).toBe(3);
    await expect(runJudgeTick(app.db, T0, log)).resolves.toMatchObject({ ran: true, hits: 0, groups: 0 });
    expect(await cases()).toEqual([]);
    expect(await cursor()).toEqual([{ received_upto: String(T0 - MIN) }]);
    expect(logged()).toEqual([{ null_ts: 3, msg: NULL_TS_MSG }]);
    for (const s of [POISON_TS, "198.51.", "0000-01-01"]) expect(lines.join("\n")).not.toContain(s);
  });
});

describe("可轉換 NULL 與已寫入列同時在一批", () => {
  it("較早的已寫入列仍判定，cursor 停在待回填列的 received_at 之前", async () => {
    app = await bootJudgeApp();
    lines = [];
    await insertFlowEvents(app.db, susp(30, T0 - 2 * MIN, T0 - 3 * MIN));
    await insertLegacyFlowEvents(app.db, susp(30, T0 - MIN, T0 - 3 * MIN));
    await expect(runJudgeTick(app.db, T0, log)).resolves.toMatchObject({ ran: true, hits: 1, groups: 1 });
    expect(await cursor()).toEqual([{ received_upto: String(T0 - 2 * MIN) }]);
    expect(logged()).toEqual([{ pending_backfill: 30, msg: PENDING_MSG }]);
  });
});
