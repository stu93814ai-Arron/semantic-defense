import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ControlApi } from "./helpers/app.js";
import { PENDING_NOW as NOW, bootPending, closeAfterEach, pendingOps, seedManualEntries } from "./helpers/pending.js";

/**
 * 核准被防護擋下時的稽核（A 組領航員裁示，未經使用者確認）：主交易回滾後另開交易寫 blacklist.approve_blocked，
 * detail 只有 {case_id, reason}，不含 IP；cap 每個 operator 每小時最多一筆。其他 409 仍不寫稽核。
 */
let app: ControlApi;
const logs = closeAfterEach(() => app);
const { op, seedCase, approve, audits, expectNoIp } = pendingOps(() => app, logs);
const HOUR = 60 * 60_000;

const seedEntry = (at: number) => seedManualEntries(app, 1, { at });

const blocked = async () => (await audits()).filter((a) => a.action === "blacklist.approve_blocked");

describe("blacklist.approve_blocked（cap）", () => {
  it("429 後寫一筆 {case_id, reason:cap}；同一 operator 1 小時內不再寫；過窗再擋才寫第二筆", async () => {
    let clock = NOW;
    app = await bootPending({ approvePerHour: 1, now: () => clock }, logs);
    await seedEntry(NOW - 10 * 60_000);
    const c = await op();
    const id = await seedCase();
    expect((await approve(c, id)).statusCode).toBe(429);
    const other = randomUUID();
    expect((await approve(c, other)).statusCode).toBe(429);
    let rows = await blocked();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "operator1" });
    expect(rows[0]!.detail).toEqual({ case_id: id, reason: "cap" });
    clock = NOW + HOUR + 1;
    await seedEntry(NOW + 30 * 60_000);
    expect((await approve(await op(), id)).statusCode).toBe(429);
    rows = await blocked();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.detail).toEqual({ case_id: id, reason: "cap" });
    expect((await audits()).every((a) => a.action === "blacklist.approve_blocked")).toBe(true);
    await expectNoIp();
  });

  it("其他 409（已核准）與成功核准都不寫 approve_blocked", async () => {
    app = await bootPending({ approvePerHour: 5 }, logs);
    const c = await op();
    const id = await seedCase();
    expect((await approve(c, id)).statusCode).toBe(200);
    expect((await approve(c, id)).statusCode).toBe(409);
    expect(await blocked()).toEqual([]);
  });
});
