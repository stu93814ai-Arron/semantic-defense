import { describe, expect, it } from "vitest";
import type { ControlApi } from "./helpers/app.js";
import { PENDING_NOW as NOW, bootPending, closeAfterEach, pendingOps, seedManualEntries } from "./helpers/pending.js";

/**
 * 核准防護告警（A 組領航員裁示，未經使用者確認）：
 * - approve_cap：operator 被上限擋下時入列，每人每小時一次（跟 approve_blocked cap 稽核同去重）。
 * - approve_volume：單一 operator ≥ ceil(0.8×上限) 或全體 ≥ 100／小時；旗標每段只告一次，低於門檻才解除。
 * payload 只有 kind、at、delivery_id（不含帳號、IP）。
 */
let app: ControlApi;
const logs = closeAfterEach(() => app);
const { op, seedCase, approve } = pendingOps(() => app, logs);
const HOUR = 60 * 60_000;
const seed = (n: number, over?: { actor?: string; at?: number }) => seedManualEntries(app, n, over);
let caseSeq = 0;
const nextCase = () => seedCase({ ip: `64.0.116.${++caseSeq % 250}/32` });

const outbox = async (kind: string) =>
  (await app.db.query<{ channel: string; payload: Record<string, unknown> }>(
    "SELECT channel, payload FROM alert_outbox WHERE kind = $1 ORDER BY id", [kind])).rows;

function expectBarePayload(rows: Array<{ payload: Record<string, unknown> }>, kind: string, at: number): void {
  for (const r of rows) {
    expect(Object.keys(r.payload).sort()).toEqual(["at", "delivery_id", "kind"]);
    expect(r.payload).toMatchObject({ kind, at });
  }
  expect(JSON.stringify(rows)).not.toMatch(/operator1|64\.0\.11/);
}

describe("approve_cap", () => {
  it("被上限擋下入列一次（每通道一筆）；同一 operator 1 小時內再擋不再入列", async () => {
    app = await bootPending({ approvePerHour: 1, alertChannels: ["webhook", "syslog"] }, logs);
    await seed(1);
    const c = await op();
    expect((await approve(c, await nextCase())).statusCode).toBe(429);
    expect((await approve(c, await nextCase())).statusCode).toBe(429);
    const rows = await outbox("approve_cap");
    expect(rows.map((r) => r.channel).sort()).toEqual(["syslog", "webhook"]);
    expectBarePayload(rows, "approve_cap", NOW);
  });

  it("未設定通道 → 不寫 outbox", async () => {
    app = await bootPending({ approvePerHour: 1, alertChannels: [] }, logs);
    await seed(1);
    expect((await approve(await op(), await nextCase())).statusCode).toBe(429);
    expect(await outbox("approve_cap")).toEqual([]);
  });
});

describe("approve_volume", () => {
  it("單一 operator 達 ceil(0.8×上限) 入列；持有中不再入列", async () => {
    app = await bootPending({ approvePerHour: 5, alertChannels: ["webhook"] }, logs);
    await seed(2);
    const c = await op();
    expect((await approve(c, await nextCase())).statusCode).toBe(200);
    expect(await outbox("approve_volume")).toEqual([]);
    expect((await approve(c, await nextCase())).statusCode).toBe(200);
    expect((await approve(c, await nextCase())).statusCode).toBe(200);
    const rows = await outbox("approve_volume");
    expect(rows).toHaveLength(1);
    expectBarePayload(rows, "approve_volume", NOW);
  });

  it("全體 ≥ 100／小時入列（無人達個人門檻）；過窗低於門檻解除，下一段再告一次", async () => {
    let clock = NOW;
    app = await bootPending({ approvePerHour: 50, alertChannels: ["webhook"], now: () => clock }, logs);
    for (const actor of ["opA", "opB", "opC"]) await seed(33, { actor });
    expect((await approve(await op(), await nextCase())).statusCode).toBe(200);
    expect(await outbox("approve_volume")).toHaveLength(1);
    clock = NOW + HOUR;
    expect((await approve(await op(), await nextCase())).statusCode).toBe(200);
    expect(await outbox("approve_volume")).toHaveLength(1);
    for (const actor of ["opA", "opB", "opC"]) await seed(33, { actor, at: clock - 1000 });
    expect((await approve(await op(), await nextCase())).statusCode).toBe(200);
    expect(await outbox("approve_volume")).toHaveLength(2);
  });
});
