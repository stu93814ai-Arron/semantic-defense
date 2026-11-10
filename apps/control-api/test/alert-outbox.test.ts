import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { autoListInTx } from "../src/auto-blacklist.js";
import {
  ALERT_BACKOFF_CAP_MS, alertBackoffMs, assertWebhookSecret, enqueueAlerts, type AlertChannel,
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
