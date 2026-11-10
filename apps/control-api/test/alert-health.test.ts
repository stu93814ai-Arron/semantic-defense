import { afterEach, describe, expect, it } from "vitest";
import { AlertSendError, deliverDueAlerts, enqueueAlerts } from "../src/alert-outbox.js";
import { ALERT_MAX_ATTEMPTS } from "../src/alert-outbox.js";
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
});
