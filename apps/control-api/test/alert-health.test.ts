import { afterEach, describe, expect, it } from "vitest";
import { AlertSendError, ALERT_FAILED_RETENTION_MS, ALERT_MAX_ATTEMPTS, deliverDueAlerts, enqueueAlerts, purgeAlertOutbox } from "../src/alert-outbox.js";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { requireLoginCookie } from "./helpers/boot-fixtures.js";
import { cookieHeader } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });
const NOW = Date.parse("2026-11-11T00:00:00Z");

async function boot(): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW });
  await seedPhase2Fixtures(app);
  return app;
}

async function health(): Promise<{ status: string; alerts: Record<string, unknown> }> {
  const cookie = await requireLoginCookie(app, "admin1", "pass-admin-1");
  const res = await app.inject({ method: "GET", url: "/api/health", headers: cookieHeader(cookie) });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("GET /api/health 告警計數", () => {
  it("空庫是零；重試用盡後 failed／undelivered／last_failed_at 可見，且不含 URL／host／原文", async () => {
    await boot();
    const empty = await health();
    expect(empty.status).toBe("ok");
    expect(empty.alerts).toMatchObject({ pending: 0, failed: 0, delivered_1h: 0, undelivered: 0, last_failed_at: null });
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["webhook"], kind: "auto_list", now: NOW, entryId: "e", caseId: "c" }));
    const send = async () => { throw new AlertSendError("webhook_timeout"); };
    let t = NOW;
    for (let i = 0; i < ALERT_MAX_ATTEMPTS; i++) {
      await deliverDueAlerts(app.db, t, { webhook: send });
      const next = (await app.db.query<{ next_attempt_at: string }>("SELECT next_attempt_at FROM alert_outbox")).rows[0];
      t = next ? Number(next.next_attempt_at) : t + 60_000;
    }
    const got = await health();
    expect(got.alerts).toMatchObject({ pending: 0, failed: 1, undelivered: 1 });
    expect(got.alerts.last_failed_at).toEqual(expect.any(Number));
    expect(JSON.stringify(got)).not.toMatch(/https?:|webhook_timeout|password|64\.0\./i);
  });

  it("last_failed_at 讀 max(failed_at)，不讀 next_attempt_at", async () => {
    await boot();
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["webhook"], kind: "auto_list", now: NOW, entryId: "e", caseId: "c" }));
    const send = async () => { throw new AlertSendError("webhook_timeout"); };
    let t = NOW;
    for (let i = 0; i < ALERT_MAX_ATTEMPTS; i++) {
      await deliverDueAlerts(app.db, t, { webhook: send });
      const next = (await app.db.query<{ next_attempt_at: string }>("SELECT next_attempt_at FROM alert_outbox")).rows[0];
      t = next ? Number(next.next_attempt_at) : t + 60_000;
    }
    const failedAt = (await health()).alerts.last_failed_at;
    expect(failedAt).toEqual(expect.any(Number));
    const bumped = Number(failedAt) + 86_400_000;
    await app.db.query("UPDATE alert_outbox SET next_attempt_at = $1", [bumped]);
    const got = await health();
    expect(got.alerts.last_failed_at).toBe(failedAt);
    expect(got.alerts.last_failed_at).not.toBe(bumped);
  });

  it("purge 寫一筆 count-only 的 alert.purged，health 讀近 24 小時且重啟後仍在", async () => {
    await boot();
    const day = 24 * 60 * 60_000;
    const stale = NOW - ALERT_FAILED_RETENTION_MS - 1;
    await app.db.query(
      `INSERT INTO alert_outbox (channel, kind, payload, attempts, next_attempt_at, status, error_class, created_at, delivered_at)
       VALUES ('webhook','auto_list','{"kind":"auto_list","delivery_id":"1"}',8,$1,'failed','x',$2,NULL),
              ('email','auto_list','{"kind":"auto_list","delivery_id":"2"}',1,$1,'delivered',NULL,$3,$3)`,
      [NOW, stale, stale],
    );
    await app.db.query(
      "INSERT INTO audit_events (action, actor, sensor_id, at, detail) VALUES ('alert.purged','system:auto',NULL,$1,'{\"count\":99}')",
      [NOW - day - 1],
    );
    expect((await health()).alerts.purged).toBe(0);
    expect(await purgeAlertOutbox(app.db, NOW)).toBe(2);
    const mid = await health();
    expect(mid.alerts.purged).toBe(2);
    const audits = (await app.db.query<{ action: string; detail: Record<string, unknown> }>(
      "SELECT action, detail FROM audit_events WHERE action = 'alert.purged' AND at >= $1",
      [NOW],
    )).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toEqual({ count: 2 });
    expect(Object.keys(audits[0]!.detail).sort()).toEqual(["count"]);
    expect(JSON.stringify(audits)).not.toMatch(/https?:|password|64\.0\./i);
    const url = requireDatabaseUrl();
    await app.close();
    app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: url, now: () => NOW });
    const after = await health();
    expect(after.alerts.purged).toBe(2);
  });
});
