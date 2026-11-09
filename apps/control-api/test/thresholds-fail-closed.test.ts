import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { loadThresholds } from "../src/thresholds.js";
import { writeAutoBlocklistEntry } from "./helpers/auto-list.js";

/** 資安 R3：舊表（舊 CHECK）留下不合新上下限的值 → fail-closed 退回預設 0.50／0.90 並 log.warn；不寫回 DB、不做 migration。 */
let app: ControlApi;
let lines: string[] = [];
afterEach(async () => {
  if (!app) return;
  await app.db.exec("DROP TABLE IF EXISTS thresholds"); // 下一個 buildApp 以新 DDL 重建
  await app.close();
});

const NOW = Date.parse("2026-11-09T00:00:00Z");
async function bootWithLegacyRow(): Promise<void> {
  lines = [];
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW,
    logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } } });
  await seedPhase2Fixtures(app);
  await app.db.exec("DROP TABLE thresholds");
  await app.db.exec(`CREATE TABLE thresholds (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    case_threshold DOUBLE PRECISION NOT NULL, auto_threshold DOUBLE PRECISION NOT NULL,
    CHECK (0 <= case_threshold AND case_threshold <= auto_threshold AND auto_threshold <= 1))`);
  await app.db.query("INSERT INTO thresholds (id, case_threshold, auto_threshold) VALUES (TRUE, 0, 0)");
}
const auto = (confidence: number, ip: string) =>
  writeAutoBlocklistEntry(app.db, { ip, confidence, case_id: randomUUID() }, NOW);
const warns = () => lines.map((l) => JSON.parse(l) as { level: number; msg?: string }).filter((x) => x.level === 40);

describe("loadThresholds fail-closed", () => {
  it("舊表 {0,0} → 判定用 0.50／0.90；0.01、0.89 不上榜，0.90 上榜；DB 值不被改寫", async () => {
    await bootWithLegacyRow();
    expect(await loadThresholds(app.db)).toEqual({ case: 0.5, auto: 0.9 });
    expect(await auto(0.01, "64.0.113.1")).toEqual({ status: "below_auto_threshold" });
    expect(await auto(0.89, "64.0.113.2")).toEqual({ status: "below_auto_threshold" });
    expect((await auto(0.9, "64.0.113.3")).status).toBe("listed");
    expect((await app.db.query("SELECT case_threshold, auto_threshold FROM thresholds")).rows)
      .toEqual([{ case_threshold: 0, auto_threshold: 0 }]);
  });

  it("GET 回實際生效值（＝判定用值 0.50／0.90），並寫 log.warn（不含原值以外的請求資料）", async () => {
    await bootWithLegacyRow();
    const c = (await login(app, { username: "admin1", password: "pass-admin-1" })).cookie!;
    const r = await app.inject({ method: "GET", url: ADMIN_API_PATHS.thresholds, headers: cookieHeader(c) });
    expect([r.statusCode, r.json()]).toEqual([200, { case: 0.5, auto: 0.9 }]);
    expect(r.json()).toEqual(await loadThresholds(app.db));
    expect(warns().length).toBeGreaterThanOrEqual(1);
  });
});
