import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CASE_TTL_MS } from "../src/cases.js";
import type { ControlApi } from "./helpers/app.js";
import { PENDING_HOST, PENDING_NOW, activeBlocklist, asOperator, bootPending, closeAfterEach, pendingOps } from "./helpers/pending.js";

/** 待審退回：無本文、204、稽核不寫理由也不含 IP；衝突與核准並發。 */
let app: ControlApi;
const logs = closeAfterEach(() => app);

const NOW = PENDING_NOW;
const { as, approve, reject, seedCase, audits, caseRow, expectNoIp } = pendingOps(() => app, logs);

describe("POST /api/blacklist/pending/:caseId/reject（正向與權限）", () => {
  it("operator 退回成功：204 無本文；案件轉 rejected；稽核只含 case_id、無理由、無 IP", async () => {
    app = await bootPending({}, logs);
    const id = await seedCase();
    const r = await reject(await asOperator(app), id);
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe("");
    expect(await caseRow(id)).toEqual({ state: "rejected", resolved_by: "operator1", resolved_at: String(NOW) });
    expect(await activeBlocklist(app)).toEqual([]);
    const a = await audits();
    expect(a).toEqual([{ action: "blacklist.reject", actor: "operator1", detail: { case_id: id } }]);
    expect(JSON.stringify(a[0]!.detail)).not.toMatch(/reason|理由|note|comment/i);
    await expectNoIp();
  });

  it("帶本文也不收、稽核不寫理由", async () => {
    app = await bootPending({}, logs);
    const id = await seedCase();
    const r = await reject(await asOperator(app), id, { reason: "誤報" });
    expect(r.statusCode).toBe(204);
    expect(await audits()).toEqual([{ action: "blacklist.reject", actor: "operator1", detail: { case_id: id } }]);
    await expectNoIp();
  });

  it("不存在／非 uuid／大寫 uuid → 404，不寫稽核", async () => {
    app = await bootPending({}, logs);
    const c = await asOperator(app);
    expect((await reject(c, randomUUID())).statusCode).toBe(404);
    expect((await reject(c, "nope")).statusCode).toBe(404);
    const id = await seedCase();
    expect((await reject(c, id.toUpperCase())).statusCode).toBe(404);
    expect(await caseRow(id)).toMatchObject({ state: "open", resolved_at: null });
    expect(await audits()).toEqual([]);
    expect((await reject(c, "nope")).json()).toEqual({ error: "查無待審案件" });
    await expectNoIp();
  });

  it("platform_admin、app_owner 403；匿名 401；案件不變", async () => {
    app = await bootPending({}, logs);
    const id = await seedCase();
    for (const [u, p] of [["admin1", "pass-admin-1"], ["owner1", "pass-owner-1"]] as const) {
      expect((await reject(await as(u, p), id)).statusCode, u).toBe(403);
    }
    expect((await reject(undefined, id)).statusCode).toBe(401);
    expect(await caseRow(id)).toMatchObject({ state: "open", resolved_at: null });
    expect(await audits()).toEqual([]);
    await expectNoIp();
  });
});

describe("退回衝突與核准並發", () => {
  it("重複退回、已核准、已自動上榜、已到期、時鐘偏斜 → 對應 409，不寫稽核", async () => {
    app = await bootPending({}, logs);
    const c = await asOperator(app);
    const open = await seedCase();
    expect((await reject(c, open)).statusCode).toBe(204);
    expect((await reject(c, open)).json()).toEqual({ error: "已退回" });
    const approved = await seedCase({ ip: "64.0.113.31/32", state: "approved", resolvedBy: "operator1", resolvedAt: NOW - 1 });
    const auto = await seedCase({ ip: "64.0.113.32/32", state: "auto_listed", resolvedBy: "system:auto", resolvedAt: NOW - 1 });
    const expired = await seedCase({ ip: "64.0.113.33/32", state: "expired", created: NOW - CASE_TTL_MS, resolvedAt: NOW - 1 });
    const stale = await seedCase({ ip: "64.0.113.34/32", created: NOW - CASE_TTL_MS });
    const skew = await seedCase({ ip: "64.0.113.35/32", created: NOW + 3600_000 });
    expect((await reject(c, approved)).json()).toEqual({ error: "已核准" });
    expect((await reject(c, auto)).json()).toEqual({ error: "已自動上榜" });
    expect((await reject(c, expired)).json()).toEqual({ error: "已到期" });
    expect((await reject(c, stale)).json()).toEqual({ error: "已到期" });
    expect((await reject(c, skew)).json()).toEqual({ error: "clock_skew" });
    expect(await caseRow(skew)).toMatchObject({ state: "open", resolved_at: null });
    expect((await audits()).map((a) => a.action)).toEqual(["blacklist.reject"]);
    await expectNoIp();
  });

  it("approve 與 reject 同時進來：一個成功、一個 409，狀態一致且只一筆稽核", async () => {
    app = await bootPending({}, logs);
    const [a, b] = [await asOperator(app), await asOperator(app)];
    const id = await seedCase();
    const [ra, rr] = await Promise.all([approve(a, id), reject(b, id)]);
    const codes = [ra.statusCode, rr.statusCode].sort();
    expect(codes[1]).toBe(409);
    expect([200, 204]).toContain(codes[0]);
    const row = await caseRow(id);
    const arows = await audits();
    expect(arows).toHaveLength(1);
    if (ra.statusCode === 200) {
      expect(rr.statusCode).toBe(409);
      expect(row).toMatchObject({ state: "approved", resolved_by: "operator1" });
      expect(await activeBlocklist(app)).toEqual([{ ip: PENDING_HOST }]);
      expect(arows[0]).toMatchObject({ action: "blacklist.approve", detail: { case_id: id } });
    } else {
      expect(rr.statusCode).toBe(204);
      expect(row).toEqual({ state: "rejected", resolved_by: "operator1", resolved_at: String(NOW) });
      expect(await activeBlocklist(app)).toEqual([]);
      expect(arows[0]).toEqual({ action: "blacklist.reject", actor: "operator1", detail: { case_id: id } });
    }
    const err = ra.statusCode === 409 ? ra.json() : rr.json();
    await expectNoIp(err);
  });
});
