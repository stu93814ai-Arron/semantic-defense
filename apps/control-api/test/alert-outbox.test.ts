import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { autoListInTx } from "../src/auto-blacklist.js";
import {
  ALERT_BACKOFF_CAP_MS, ALERT_MAX_ATTEMPTS, AlertSendError, alertBackoffMs, alertHealthCounts,
  assertWebhookSecret, deliverDueAlerts, enqueueAlerts, type AlertChannel, type OutboxRow,
} from "../src/alert-outbox.js";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { writeAutoBlocklistEntry } from "./helpers/auto-list.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const NOW = Date.parse("2026-11-11T00:00:00Z");
const IP = "64.0.113.7";
const input = (ip = IP) => ({ ip, confidence: 0.95, case_id: randomUUID() });

async function boot(opts: { alertChannels?: readonly AlertChannel[] } = {}): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW, ...opts });
  await seedPhase2Fixtures(app);
  return app;
}

const rows = async (): Promise<Array<{ id: string; channel: string; kind: string; status: string; attempts: number; payload: Record<string, unknown>; error_class: string | null; next_attempt_at: string }>> =>
  (await app.db.query<{ id: string; channel: string; kind: string; status: string; attempts: number; payload: Record<string, unknown>; error_class: string | null; next_attempt_at: string }>("SELECT id, channel, kind, status, attempts, payload, error_class, next_attempt_at FROM alert_outbox ORDER BY id")).rows;

const audits = async (action: string) =>
  (await app.db.query<{ detail: Record<string, unknown> }>("SELECT detail FROM audit_events WHERE action = $1 ORDER BY id", [action])).rows;

describe("alertBackoffMs", () => {
  it("1s 起跳、倍增、上限 15 分鐘", () => {
    expect([1, 2, 3, 4].map(alertBackoffMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(alertBackoffMs(20)).toBe(ALERT_BACKOFF_CAP_MS);
  });
});

describe("assertWebhookSecret", () => {
  it("未設 URL 不檢查；設了但金鑰太短或缺失則 throw", () => {
    expect(() => assertWebhookSecret({})).not.toThrow();
    expect(() => assertWebhookSecret({ SD_ALERT_WEBHOOK_URL: "https://example.test/h" })).toThrow(/HMAC/);
    expect(() => assertWebhookSecret({ SD_ALERT_WEBHOOK_URL: "https://example.test/h", SD_ALERT_WEBHOOK_HMAC_SECRET: "x".repeat(31) })).toThrow(/HMAC/);
    expect(() => assertWebhookSecret({ SD_ALERT_WEBHOOK_URL: "https://example.test/h", SD_ALERT_WEBHOOK_HMAC_SECRET: "x".repeat(32) })).not.toThrow();
  });
});

describe("outbox 入列（與 auto_list 同交易）", () => {
  it("無通道時不上 outbox；有通道時 payload 只有 delivery_id/kind/entry_id/case_id", async () => {
    await boot();
    const listed = await writeAutoBlocklistEntry(app.db, input(), NOW);
    expect(listed.status).toBe("listed");
    expect(await rows()).toEqual([]);
    if (listed.status !== "listed") return;
    const ids = await app.db.tx((q) => enqueueAlerts(q, {
      channels: ["webhook", "email"], kind: "auto_list", now: NOW,
      entryId: listed.entry.entry_id, caseId: listed.entry.case_id,
    }));
    expect(ids).toHaveLength(2);
    const got = await rows();
    expect(got.map((r) => r.channel)).toEqual(["webhook", "email"]);
    for (const r of got) {
      expect(r.status).toBe("pending");
      expect(r.kind).toBe("auto_list");
      expect(r.payload).toEqual({ delivery_id: r.id, kind: "auto_list", entry_id: listed.entry.entry_id, case_id: listed.entry.case_id });
      expect(JSON.stringify(r.payload)).not.toMatch(/64\.0\.|entry\.ip|https?:/i);
      expect(Object.keys(r.payload).sort()).toEqual(["case_id", "delivery_id", "entry_id", "kind"]);
    }
  });

  it("經 autoListInTx 入列；already_listed 不再入列；交易回滾不留列", async () => {
    await boot();
    const first = input();
    const listed = await app.db.tx((q) => autoListInTx(q, first, NOW, { alertChannels: ["webhook"] }));
    expect(listed.status).toBe("listed");
    expect((await rows()).map((r) => r.channel)).toEqual(["webhook"]);
    const again = await app.db.tx((q) => autoListInTx(q, first, NOW, { alertChannels: ["webhook"] }));
    expect(again.status).toBe("already_listed");
    expect(await rows()).toHaveLength(1);
    await expect(app.db.tx(async (q) => {
      await autoListInTx(q, input("64.0.113.8"), NOW, { alertChannels: ["email"] });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await rows()).map((r) => r.channel)).toEqual(["webhook"]);
  });
});

describe("發送迴圈：租約、重試、優先、清除", () => {
  it("成功後 delivered；發送期間不持列鎖", async () => {
    await boot();
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["webhook"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1" }));
    const [row] = await rows();
    const lockCheck: string[] = [];
    const send = async (claimed: OutboxRow) => {
      const c = new pg.Client({ connectionString: requireDatabaseUrl() });
      await c.connect();
      try {
        await c.query("BEGIN");
        const r = await c.query("SELECT id FROM alert_outbox WHERE id = $1 FOR UPDATE NOWAIT", [claimed.id]);
        lockCheck.push(r.rows.length === 1 ? "unlocked" : "empty");
        await c.query("ROLLBACK");
      } finally {
        await c.end();
      }
    };
    expect(await deliverDueAlerts(app.db, NOW, { webhook: send })).toEqual({ delivered: 1, failed: 0, retried: 0 });
    expect(lockCheck).toEqual(["unlocked"]);
    expect((await rows())[0]).toMatchObject({ id: row!.id, status: "delivered", payload: expect.objectContaining({ delivery_id: row!.id }) });
    expect(await alertHealthCounts(app.db, NOW)).toMatchObject({ pending: 0, failed: 0, delivered_1h: 1 });
  });

  it("失敗退避後重試；用盡則 failed、delivery_failed 只含 error_class、error log 只有計數", async () => {
    await boot();
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["syslog"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1" }));
    const logs: Array<{ obj: object; msg: string }> = [];
    const log = { error: (obj: object, msg: string) => { logs.push({ obj, msg }); } };
    const send = async () => { throw new AlertSendError("syslog_timeout"); };
    let t = NOW;
    for (let i = 1; i < ALERT_MAX_ATTEMPTS; i++) {
      expect(await deliverDueAlerts(app.db, t, { syslog: send }, log)).toEqual({ delivered: 0, failed: 0, retried: 1 });
      const [r] = await rows();
      expect(r).toMatchObject({ status: "pending", attempts: i, error_class: "syslog_timeout" });
      expect(Number(r!.next_attempt_at)).toBe(t + alertBackoffMs(i));
      t = Number(r!.next_attempt_at);
    }
    expect(await deliverDueAlerts(app.db, t, { syslog: send }, log)).toEqual({ delivered: 0, failed: 1, retried: 0 });
    const [final] = await rows();
    expect(final).toMatchObject({ status: "failed", attempts: ALERT_MAX_ATTEMPTS, error_class: "syslog_timeout" });
    const failed = await audits("alert.delivery_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toEqual({
      delivery_id: final!.id, channel: "syslog", kind: "auto_list", error_class: "syslog_timeout", attempts: ALERT_MAX_ATTEMPTS,
    });
    expect(JSON.stringify({ audit: failed, logs, row: final })).not.toMatch(/64\.0\.|https?:|postgres:|password/i);
    expect(logs.filter((x) => x.msg === "alert delivery exhausted").map((x) => x.obj)).toEqual([{ failed: 1, attempts: ALERT_MAX_ATTEMPTS }]);
    expect(await alertHealthCounts(app.db, t)).toMatchObject({ pending: 0, failed: 1 });
  });

});

describe("發送迴圈：優先順序與保留", () => {
  it("volume／breaker_open 優先於 auto_list；送出後未更新則租約到期後以同一 delivery_id 重送", async () => {
    await boot();
    await app.db.tx(async (q) => {
      await enqueueAlerts(q, { channels: ["webhook"], kind: "auto_list", now: NOW });
      await enqueueAlerts(q, { channels: ["webhook"], kind: "volume", now: NOW });
      await enqueueAlerts(q, { channels: ["webhook"], kind: "breaker_open", now: NOW });
    });
    const seen: string[] = [];
    const send = async (row: OutboxRow) => { seen.push(row.kind); };
    await deliverDueAlerts(app.db, NOW, { webhook: send });
    expect(seen).toEqual(["breaker_open", "volume", "auto_list"]);
    await app.db.query("UPDATE alert_outbox SET status = 'pending', delivered_at = NULL, next_attempt_at = $1, attempts = 0", [NOW]);
    expect(await deliverDueAlerts(app.db, NOW, { webhook: async () => undefined })).toEqual({ delivered: 3, failed: 0, retried: 0 });
    await app.db.query("UPDATE alert_outbox SET status = 'pending', delivered_at = NULL WHERE status = 'delivered'");
    const before = await rows();
    await deliverDueAlerts(app.db, NOW + 60_000, { webhook: async () => undefined });
    const after = await rows();
    expect(after.map((r) => r.payload)).toEqual(before.map((r) => r.payload));
    expect(after.every((r) => r.status === "delivered")).toBe(true);
  });

  it("超過保留或總數上限時刪最舊的已完成列，只記筆數", async () => {
    await boot();
    const logs: object[] = [];
    const log = { error: (obj: object) => { logs.push(obj); } };
    await app.db.query(
      `INSERT INTO alert_outbox (channel, kind, payload, attempts, next_attempt_at, status, error_class, created_at, delivered_at)
       VALUES ('webhook','auto_list','{"kind":"auto_list","delivery_id":"1"}',8,$1,'failed','x',$2,NULL),
              ('email','auto_list','{"kind":"auto_list","delivery_id":"2"}',1,$1,'delivered',NULL,$3,$3)`,
      [NOW, NOW - 31 * 24 * 60 * 60_000, NOW],
    );
    const n = await (await import("../src/alert-outbox.js")).purgeAlertOutbox(app.db, NOW, 1, log);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await rows()).every((r) => r.status !== "failed" || Number(r.next_attempt_at) >= NOW - 30 * 24 * 60 * 60_000)).toBe(true);
    expect(logs.some((o) => "purged" in o && Object.keys(o).join() === "purged")).toBe(true);
  });
});

describe("發送迴圈：單筆整體期限", () => {
  it("卡住的通道在期限內記為逾時失敗，其他通道仍完成，且總時間不超過租約", async () => {
    await boot();
    await app.db.tx((q) => enqueueAlerts(q, {
      channels: ["email", "webhook", "syslog"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1",
    }));
    const deadline = 200;
    const t0 = Date.now();
    const out = await deliverDueAlerts(app.db, NOW, {
      email: async () => undefined,
      webhook: async () => new Promise(() => { /* 永不結束 */ }),
      syslog: async () => undefined,
    }, undefined, { sendDeadlineMs: deadline });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThanOrEqual(deadline + 800);
    expect(elapsed).toBeLessThan(60_000);
    expect(out).toEqual({ delivered: 2, failed: 0, retried: 1 });
    const byCh = Object.fromEntries((await rows()).map((r) => [r.channel, r]));
    expect(byCh.email).toMatchObject({ status: "delivered" });
    expect(byCh.syslog).toMatchObject({ status: "delivered" });
    expect(byCh.webhook).toMatchObject({ status: "pending", attempts: 1, error_class: "webhook_timeout" });
  }, 8_000);
});
