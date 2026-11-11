import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { CASE_TTL_MS } from "../../src/cases.js";
import { buildApp, seedPhase2Fixtures, type BuildAppOptions, type ControlApi } from "./app.js";
import { login } from "./session.js";
import { requireDatabaseUrl } from "./pg.js";

/** 待審案件測試共用：固定時鐘、種子案件與登入包裝。 */
export const PENDING_NOW = Date.parse("2026-11-11T08:00:00Z");
export const PENDING_HOST = "64.0.113.7/32";

export async function bootPending(over: BuildAppOptions = {}): Promise<ControlApi> {
  const app = await buildApp({
    idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => PENDING_NOW,
    ...over,
  });
  await seedPhase2Fixtures(app);
  return app;
}

export async function loginAs(app: ControlApi, username: string, password: string): Promise<string> {
  const r = await login(app, { username, password });
  expect(r.status).toBe(200);
  return r.cookie!;
}
export const asOperator = (app: ControlApi) => loginAs(app, "operator1", "pass-operator-1");

export type SeedCaseOver = {
  ip?: string; state?: string; conf?: number; hits?: number; created?: number; lastHit?: number;
  resolvedBy?: string | null; resolvedAt?: number | null;
};

export async function seedPendingCase(app: ControlApi, over: SeedCaseOver = {}): Promise<string> {
  const id = randomUUID();
  const created = over.created ?? PENDING_NOW - 60_000;
  await app.db.query(
    `INSERT INTO blacklist_cases (case_id, ip, state, max_confidence, hit_count, created_at, expires_at, last_hit_at, resolved_by, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id, over.ip ?? PENDING_HOST, over.state ?? "open", over.conf ?? 0.8, over.hits ?? 3,
      created, created + CASE_TTL_MS, over.lastHit ?? created,
      over.resolvedBy ?? null, over.resolvedAt ?? null,
    ],
  );
  return id;
}

/** 測試檔共用包裝：每次呼叫都讀 getApp() 目前的 app。 */
export function pendingOps(getApp: () => ControlApi) {
  return {
    as: (username: string, password: string) => loginAs(getApp(), username, password),
    op: () => asOperator(getApp()),
    seedCase: (over?: SeedCaseOver) => seedPendingCase(getApp(), over),
  };
}
