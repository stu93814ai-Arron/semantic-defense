import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTO_LIST_TTL_MS } from "../src/auto-blacklist.js";
import { CASE_TTL_MS } from "../src/cases.js";
import type { ControlApi } from "./helpers/app.js";
import { LOCK_TEST_TIMEOUT_MS, holdAllowlistInsert, lockGuardedUrl, waitShareWaiter } from "./helpers/locks.js";
import { PENDING_HOST, PENDING_IP_RE, PENDING_NOW, activeBlocklist, asOperator, bootPending, closeAfterEach, pendingOps } from "./helpers/pending.js";

/** 待審核准衝突與保護：終態／到期／時鐘／已上榜／白名單；並發雙核准、核准當下加白名單。 */
let app: ControlApi;
const logs = closeAfterEach(() => app);

const NOW = PENDING_NOW;
const HOST = PENDING_HOST;
const { approve, seedCase, audits, caseRow, expectNoIp } = pendingOps(() => app, logs);

describe("核准衝突（終態、到期、時鐘、已上榜）", () => {
  it("重複核准 → 409 已核准，不第二筆稽核、不另開列", async () => {
    app = await bootPending({}, logs);
    const c = await asOperator(app);
    const id = await seedCase();
    expect((await approve(c, id)).statusCode).toBe(200);
    const again = await approve(c, id);
    expect([again.statusCode, again.json()]).toEqual([409, { error: "已核准" }]);
    expect(await audits()).toHaveLength(1);
    expect(await activeBlocklist(app)).toEqual([{ ip: HOST }]);
    expect(JSON.stringify(again.json())).not.toMatch(PENDING_IP_RE);
    await expectNoIp();
  });

  it("已退回／已自動上榜／已到期（含仍為 open 但過期）→ 對應 409，不寫稽核、不上榜", async () => {
    app = await bootPending({}, logs);
    const c = await asOperator(app);
    const rejected = await seedCase({ ip: "64.0.113.21/32", state: "rejected", resolvedBy: "operator1", resolvedAt: NOW - 1 });
    const auto = await seedCase({ ip: "64.0.113.22/32", state: "auto_listed", resolvedBy: "system:auto", resolvedAt: NOW - 1 });
    const expired = await seedCase({ ip: "64.0.113.23/32", state: "expired", created: NOW - CASE_TTL_MS, resolvedAt: NOW - 1 });
    const staleOpen = await seedCase({ ip: "64.0.113.24/32", state: "open", created: NOW - CASE_TTL_MS });
    expect((await approve(c, rejected)).json()).toEqual({ error: "已退回" });
    expect((await approve(c, auto)).json()).toEqual({ error: "已自動上榜" });
    expect((await approve(c, expired)).json()).toEqual({ error: "已到期" });
    expect((await approve(c, staleOpen)).json()).toEqual({ error: "已到期" });
    expect((await approve(c, rejected)).statusCode).toBe(409);
    expect(await audits()).toEqual([]);
    expect(await activeBlocklist(app)).toEqual([]);
    await expectNoIp();
  });

  it("created_at 在 app 時鐘之後 → 409 clock_skew，不改列、不寫稽核", async () => {
    app = await bootPending({}, logs);
    const id = await seedCase({ created: NOW + 3600_000 });
    const r = await approve(await asOperator(app), id);
    expect([r.statusCode, r.json()]).toEqual([409, { error: "clock_skew" }]);
    expect(await caseRow(id)).toMatchObject({ state: "open", resolved_at: null });
    expect(await audits()).toEqual([]);
    await expectNoIp();
  });

  it("同 IP 已有生效黑名單 → 409 已上榜，案件仍 open、不寫稽核", async () => {
    app = await bootPending({}, logs);
    await app.db.query(
      `INSERT INTO blocklist_entries (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at)
       VALUES ($1,$2,'auto',0.95,$3,$4,$5,'system:auto',$4,NULL)`,
      [randomUUID(), HOST, randomUUID(), NOW - 60_000, NOW + AUTO_LIST_TTL_MS],
    );
    const id = await seedCase();
    const r = await approve(await asOperator(app), id);
    expect([r.statusCode, r.json()]).toEqual([409, { error: "已上榜" }]);
    expect(await caseRow(id)).toMatchObject({ state: "open", resolved_at: null });
    expect(await audits()).toEqual([]);
    expect(JSON.stringify(r.json())).not.toMatch(PENDING_IP_RE);
    await expectNoIp();
  });
});

describe("白名單必擋、並發核准", () => {
  it("IP 在有效白名單（含涵蓋 CIDR）→ 409 已在白名單；過期白名單不擋", async () => {
    app = await bootPending({}, logs);
    const c = await asOperator(app);
    await app.db.query(
      "INSERT INTO allowlist_entries VALUES ($1, $2, 'office', 'admin1', $3, NULL)",
      [randomUUID(), "64.0.113.0/24", NOW - 1000],
    );
    const blocked = await seedCase();
    const r = await approve(c, blocked);
    expect([r.statusCode, r.json()]).toEqual([409, { error: "已在白名單" }]);
    expect(await caseRow(blocked)).toMatchObject({ state: "open", resolved_at: null });
    expect(await audits()).toEqual([]);
    expect(JSON.stringify(r.json())).not.toMatch(PENDING_IP_RE);

    const other = "64.0.114.1/32";
    await app.db.query(
      "INSERT INTO allowlist_entries VALUES ($1, $2, 'office', 'admin1', $3, $4)",
      [randomUUID(), "64.0.114.0/24", NOW - 2000, NOW - 1],
    );
    const openId = await seedCase({ ip: other });
    expect((await approve(c, openId)).statusCode).toBe(200);
    await expectNoIp();
  });

  it("兩個 approve 同時進來：只有一個 200、一筆列、一筆稽核", async () => {
    app = await bootPending({}, logs);
    const [a, b] = [await asOperator(app), await asOperator(app)];
    const id = await seedCase();
    const codes = (await Promise.all([approve(a, id), approve(b, id)])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(await caseRow(id)).toMatchObject({ state: "approved", resolved_by: "operator1" });
    expect(await activeBlocklist(app)).toEqual([{ ip: HOST }]);
    expect(await audits()).toHaveLength(1);
    await expectNoIp();
  });

  it("核准當下 IP 被加進白名單：等 SHARE 後放行，核准 409、不上榜、不寫稽核", async () => {
    app = await bootPending({ databaseUrl: lockGuardedUrl() }, logs);
    const id = await seedCase();
    const c = await asOperator(app);
    const hold = await holdAllowlistInsert("64.0.113.0/24", NOW - 1000);
    const pending = approve(c, id);
    const waiter = await waitShareWaiter(app.db, 3000, "ShareLock");
    await hold.commit();
    const r = await pending;
    expect(waiter).not.toBeNull();
    expect([r.statusCode, r.json()]).toEqual([409, { error: "已在白名單" }]);
    expect(await caseRow(id)).toMatchObject({ state: "open", resolved_at: null });
    expect(await activeBlocklist(app)).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(JSON.stringify(r.json())).not.toMatch(PENDING_IP_RE);
    await expectNoIp();
  }, LOCK_TEST_TIMEOUT_MS);
});
