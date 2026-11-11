import { afterEach, describe, expect, it } from "vitest";
import { enqueueAlerts, type AlertKind } from "../src/alert-outbox.js";
import { formatMail } from "../src/alert-smtp.js";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });
const NOW = Date.parse("2026-11-11T00:00:00Z");

async function boot(): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW });
  await seedPhase2Fixtures(app);
  return app;
}

describe("R16 告警 kind（資安提出）", () => {
  it("可入列 tick_fail／cursor_lag／stale_pending；payload 只含 kind、數字與時間", async () => {
    await boot();
    await app.db.tx(async (q) => {
      await enqueueAlerts(q, { channels: ["webhook"], kind: "tick_fail" as AlertKind, now: NOW, streak: 3 });
      await enqueueAlerts(q, { channels: ["webhook"], kind: "cursor_lag" as AlertKind, now: NOW, lag_ms: 600_001 });
      await enqueueAlerts(q, { channels: ["webhook"], kind: "stale_pending" as AlertKind, now: NOW, stale_pending: 2 });
    });
    const rows = (await app.db.query<{ kind: string; payload: Record<string, unknown> }>(
      "SELECT kind, payload FROM alert_outbox ORDER BY id")).rows;
    expect(rows.map((r) => r.kind)).toEqual(["tick_fail", "cursor_lag", "stale_pending"]);
    expect(rows[0]!.payload).toEqual({ delivery_id: expect.any(String), kind: "tick_fail", at: NOW, streak: 3 });
    expect(rows[1]!.payload).toEqual({ delivery_id: expect.any(String), kind: "cursor_lag", at: NOW, lag_ms: 600_001 });
    expect(rows[2]!.payload).toEqual({ delivery_id: expect.any(String), kind: "stale_pending", at: NOW, stale_pending: 2 });
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/https?:|SELECT |64\.0\.|exception|stack/i);
  });

  it("非法 kind 仍被 CHECK 拒絕", async () => {
    await boot();
    await expect(app.db.query(
      `INSERT INTO alert_outbox (channel, kind, payload, attempts, next_attempt_at, status, created_at)
       VALUES ('webhook','other','{"kind":"other"}',0,$1,'pending',$1)`, [NOW],
    )).rejects.toMatchObject({ code: "23514" });
  });
});

describe("formatMail 含 R16 數字欄", () => {
  it("tick_fail 內文含 streak 與 at，不含位址", () => {
    const mail = formatMail({
      id: "9", audit_id: null, channel: "email", kind: "tick_fail" as AlertKind,
      payload: { delivery_id: "9", kind: "tick_fail" as AlertKind, at: NOW, streak: 3 },
      attempts: 0, next_attempt_at: "0", status: "pending", error_class: null,
      created_at: "0", delivered_at: null,
    });
    expect(mail.subject).toBe("semantic-defense tick_fail");
    expect(mail.text).toContain("kind=tick_fail");
    expect(mail.text).toContain("streak=3");
    expect(mail.text).toContain(`at=${NOW}`);
    expect(mail.text).not.toMatch(/https?:|64\.0\./);
  });
});
