import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { autoListInTx } from "../src/auto-blacklist.js";
import {
  ALERT_BACKOFF_CAP_MS, ALERT_CLAIM_LEASE_MS, ALERT_MAX_ATTEMPTS, ALERT_SEND_DEADLINE_MS,
  AlertSendError, alertBackoffMs, alertHealthCounts, clampSendDeadlineMs,
  assertWebhookSecret, claimDue, deliverDueAlerts, enqueueAlerts, markDelivered, markFailure, purgeAlertOutbox, type AlertChannel, type OutboxRow,
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
    expect(await deliverDueAlerts(app.db, NOW, { webhook: send }, undefined, { clock: () => NOW })).toEqual({ delivered: 1, failed: 0, retried: 0 });
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
      expect(await deliverDueAlerts(app.db, t, { syslog: send }, log, { clock: () => t })).toEqual({ delivered: 0, failed: 0, retried: 1 });
      const [r] = await rows();
      expect(r).toMatchObject({ status: "pending", attempts: i, error_class: "syslog_timeout" });
      expect(Number(r!.next_attempt_at)).toBe(t + alertBackoffMs(i));
      t = Number(r!.next_attempt_at);
    }
    expect(await deliverDueAlerts(app.db, t, { syslog: send }, log, { clock: () => t })).toEqual({ delivered: 0, failed: 1, retried: 0 });
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

describe("purge 不得刪 pending", () => {
  it("pending 超過上限且部分早於 30 天，purge 後筆數不變", async () => {
    await boot();
    const old = NOW - 31 * 24 * 60 * 60_000;
    await app.db.query(
      `INSERT INTO alert_outbox (channel, kind, payload, attempts, next_attempt_at, status, created_at)
       VALUES ('webhook','auto_list','{"kind":"auto_list","delivery_id":"p1"}',0,$1,'pending',$2),
              ('webhook','auto_list','{"kind":"auto_list","delivery_id":"p2"}',0,$1,'pending',$2),
              ('webhook','auto_list','{"kind":"auto_list","delivery_id":"p3"}',0,$1,'pending',$1),
              ('webhook','auto_list','{"kind":"auto_list","delivery_id":"p4"}',0,$1,'pending',$1),
              ('email','auto_list','{"kind":"auto_list","delivery_id":"p5"}',0,$1,'pending',$2)`,
      [NOW, old],
    );
    const count = async () => Number((await app.db.query<{ n: string }>("SELECT count(*) AS n FROM alert_outbox WHERE status = 'pending'")).rows[0]!.n);
    const before = await count();
    expect(before).toBeGreaterThan(2);
    const deleted = await purgeAlertOutbox(app.db, NOW, 2);
    expect(await count()).toBe(before);
    expect(deleted).toBe(0);
  });
});

describe("標記送達與失敗：租約 token", () => {
  it("先 markDelivered 再遲到的 markFailure 不得改寫 delivered，也不得寫 delivery_failed", async () => {
    await boot();
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["webhook"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1" }));
    await app.db.query("UPDATE alert_outbox SET attempts = $1", [ALERT_MAX_ATTEMPTS - 1]);
    let claimed: OutboxRow | undefined;
    await deliverDueAlerts(app.db, NOW, { webhook: async (row) => { claimed = row; } });
    expect(claimed).toBeDefined();
    expect((await rows())[0]).toMatchObject({ status: "delivered" });
    await markFailure(app.db, claimed!, NOW, "webhook_timeout");
    expect((await rows())[0]).toMatchObject({ id: claimed!.id, status: "delivered" });
    expect(await audits("alert.delivery_failed")).toEqual([]);
  });
});

describe("發送期限小於租約", () => {
  it("預設整體期限為租約減 15 秒，且必須小於租約", () => {
    expect(ALERT_SEND_DEADLINE_MS).toBe(ALERT_CLAIM_LEASE_MS - 15_000);
    expect(ALERT_SEND_DEADLINE_MS).toBeLessThan(ALERT_CLAIM_LEASE_MS);
  });

  it("sendDeadlineMs 被夾在 1 與租約減邊際之間", () => {
    expect(clampSendDeadlineMs(200)).toBe(200);
    expect(clampSendDeadlineMs(0)).toBe(1);
    expect(clampSendDeadlineMs(-5)).toBe(1);
    expect(clampSendDeadlineMs(ALERT_CLAIM_LEASE_MS)).toBe(ALERT_SEND_DEADLINE_MS);
    expect(clampSendDeadlineMs(ALERT_CLAIM_LEASE_MS - 15_000 + 1)).toBe(ALERT_SEND_DEADLINE_MS);
    expect(clampSendDeadlineMs(Number.NaN)).toBe(ALERT_SEND_DEADLINE_MS);
  });
});

describe("delivered 計數與完成時間", () => {
  it("delivered_at 是實際完成時間，不是批次開始的 now", async () => {
    await boot();
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["webhook"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1" }));
    let t = NOW;
    await deliverDueAlerts(app.db, NOW, { webhook: async () => { t = NOW + 5_000; } }, undefined, { clock: () => t });
    const r = (await app.db.query<{ delivered_at: string; status: string }>("SELECT delivered_at, status FROM alert_outbox")).rows[0]!;
    expect(r.status).toBe("delivered");
    expect(Number(r.delivered_at)).toBe(NOW + 5_000);
    expect(Number(r.delivered_at)).not.toBe(NOW);
  });

  it("markFailure 的 next_attempt_at 與 failed_at 用該列當下 clock，不是批次開始 now", async () => {
    await boot();
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["webhook"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1" }));
    let t = NOW;
    const send = async () => { t = NOW + 5_000; throw new AlertSendError("webhook_timeout"); };
    expect(await deliverDueAlerts(app.db, NOW, { webhook: send }, undefined, { clock: () => t }))
      .toEqual({ delivered: 0, failed: 0, retried: 1 });
    const r = (await rows())[0]!;
    expect(Number(r.next_attempt_at)).toBe(NOW + 5_000 + alertBackoffMs(1));
    expect(Number(r.next_attempt_at)).not.toBe(NOW + alertBackoffMs(1));
    await app.db.query("UPDATE alert_outbox SET attempts = $1", [ALERT_MAX_ATTEMPTS - 1]);
    t = NOW;
    expect(await deliverDueAlerts(app.db, NOW + 60_000, { webhook: send }, undefined, { clock: () => t }))
      .toEqual({ delivered: 0, failed: 1, retried: 0 });
    const done = (await app.db.query<{ failed_at: string; status: string }>("SELECT failed_at, status FROM alert_outbox")).rows[0]!;
    expect(done.status).toBe("failed");
    expect(Number(done.failed_at)).toBe(NOW + 5_000);
    expect(Number(done.failed_at)).not.toBe(NOW);
  });

  it("markDelivered 未更新列時 out.delivered 不計入", async () => {
    await boot();
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["webhook"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1" }));
    const send = async (row: OutboxRow) => {
      await app.db.query("UPDATE alert_outbox SET next_attempt_at = $1 WHERE id = $2", [Number(row.next_attempt_at) + 1, row.id]);
    };
    expect(await deliverDueAlerts(app.db, NOW, { webhook: send }, undefined, { clock: () => NOW }))
      .toEqual({ delivered: 0, failed: 0, retried: 0 });
    expect((await rows())[0]).toMatchObject({ status: "pending" });
  });
});

describe("租約 token 過期後不得用舊 token 標記", () => {
  it("B 重新 claim 後，A 的過期 token 呼叫 markDelivered／markFailure／用盡重試皆 ignored", async () => {
    await boot();
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["webhook"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1" }));
    const aRows = await app.db.tx((q) => claimDue(q, NOW, ["webhook"], 16));
    const a = aRows[0]!;
    const bRows = await app.db.tx((q) => claimDue(q, NOW + ALERT_CLAIM_LEASE_MS, ["webhook"], 16));
    const b = bRows[0]!;
    expect(b.next_attempt_at).not.toBe(a.next_attempt_at);
    const before = await rows();
    expect(await markDelivered(app.db, a, NOW)).toBe("ignored");
    expect(await markFailure(app.db, a, NOW, "webhook_timeout")).toBe("ignored");
    const exhausted = { ...a, attempts: ALERT_MAX_ATTEMPTS - 1 };
    expect(await markFailure(app.db, exhausted, NOW, "webhook_timeout")).toBe("ignored");
    expect(await rows()).toEqual(before);
    expect(before[0]).toMatchObject({ id: b.id, status: "pending", next_attempt_at: b.next_attempt_at });
    expect(await audits("alert.delivery_failed")).toEqual([]);
  });
});
