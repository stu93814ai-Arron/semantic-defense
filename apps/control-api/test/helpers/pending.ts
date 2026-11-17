import { randomUUID } from "node:crypto";
import { afterEach, expect } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts";
import { CASE_TTL_MS } from "../../src/cases.js";
import { buildApp, seedPhase2Fixtures, type BuildAppOptions, type ControlApi } from "./app.js";
import { cookieHeader, login } from "./session.js";
import { requireDatabaseUrl } from "./pg.js";

/** 待審案件測試共用：固定時鐘、種子案件與登入包裝。 */
export const PENDING_NOW = Date.parse("2026-11-11T08:00:00Z");
export const PENDING_HOST = "64.0.113.7/32";
export const PENDING_IP_RE = /64\.0\.113\.7/;

export async function bootPending(over: BuildAppOptions = {}, logs?: string[]): Promise<ControlApi> {
  const logger = logs
    ? { level: "info" as const, stream: { write: (l: string) => { logs.push(l); } } }
    : over.logger;
  const app = await buildApp({
    idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => PENDING_NOW,
    ...over, logger,
  });
  await seedPhase2Fixtures(app);
  return app;
}

/** 每個測試後關閉目前的 app，並清空回傳的 logs 陣列。 */
export function closeAfterEach(getApp: () => ControlApi | undefined): string[] {
  const logs: string[] = [];
  afterEach(async () => { const app = getApp(); if (app) await app.close(); logs.length = 0; });
  return logs;
}

export async function loginAs(app: ControlApi, username: string, password: string): Promise<string> {
  const r = await login(app, { username, password });
  expect(r.status).toBe(200);
  return r.cookie!;
}
export const asOperator = (app: ControlApi) => loginAs(app, "operator1", "pass-operator-1");

export const approveUrl = (id: string) => ADMIN_API_PATHS.blacklistPendingApprove.replace(":caseId", id);
export const rejectUrl = (id: string) => ADMIN_API_PATHS.blacklistPendingReject.replace(":caseId", id);
export const approveReq = (app: ControlApi, c: string | undefined, id: string) =>
  app.inject({ method: "POST", url: approveUrl(id), headers: c ? cookieHeader(c) : {} });
/** 退回不收本文；payload 只用來驗證帶了本文也被忽略。 */
export const rejectReq = (app: ControlApi, c: string | undefined, id: string, payload?: Record<string, string>) =>
  payload === undefined
    ? app.inject({ method: "POST", url: rejectUrl(id), headers: c ? cookieHeader(c) : {} })
    : app.inject({ method: "POST", url: rejectUrl(id), headers: c ? cookieHeader(c) : {}, payload });

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

export const pendingAudits = async (app: ControlApi) =>
  (await app.db.query<{ action: string; actor: string; detail: Record<string, unknown> }>(
    "SELECT action, actor, detail FROM audit_events WHERE action LIKE 'blacklist.%' ORDER BY id")).rows;

export const pendingCase = async (app: ControlApi, id: string) =>
  (await app.db.query<{ state: string; resolved_by: string | null; resolved_at: string | null }>(
    "SELECT state, resolved_by, resolved_at FROM blacklist_cases WHERE case_id = $1", [id])).rows[0]!;

export const activeBlocklist = async (app: ControlApi) =>
  (await app.db.query<{ ip: string }>(
    "SELECT ip FROM blocklist_entries WHERE revoked_at IS NULL AND ended_at IS NULL")).rows;

/**
 * 測試檔共用包裝：每次呼叫都讀 getApp() 目前的 app。
 * expectNoIp 斷言稽核、logs（與選填的額外物件）都不含測試 IP。
 */
export function pendingOps(getApp: () => ControlApi, logs: string[] = []) {
  return {
    as: (username: string, password: string) => loginAs(getApp(), username, password),
    op: () => asOperator(getApp()),
    seedCase: (over?: SeedCaseOver) => seedPendingCase(getApp(), over),
    approve: (c: string | undefined, id: string) => approveReq(getApp(), c, id),
    reject: (c: string | undefined, id: string, payload?: Record<string, string>) => rejectReq(getApp(), c, id, payload),
    audits: () => pendingAudits(getApp()),
    caseRow: (id: string) => pendingCase(getApp(), id),
    expectNoIp: async (extra?: unknown) => {
      expect(JSON.stringify(await pendingAudits(getApp()))).not.toMatch(PENDING_IP_RE);
      expect(logs.join("\n")).not.toMatch(PENDING_IP_RE);
      if (extra !== undefined) expect(JSON.stringify(extra)).not.toMatch(PENDING_IP_RE);
    },
  };
}

export type SeedManualOver = { actor?: string; at?: number; source?: string };
let manualSeq = 0;
/** 直接寫入 n 筆 entry（核准上限的計數來源），IP 用 64.1.x.y 依序遞增，與案件 IP 不衝突。 */
export async function seedManualEntries(app: ControlApi, n: number, over: SeedManualOver = {}): Promise<void> {
  const at = over.at ?? PENDING_NOW - 10 * 60_000;
  await app.db.query(
    `INSERT INTO blocklist_entries (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at)
     SELECT gen_random_uuid(), '64.1.' || ((g + $5::int) / 250) || '.' || ((g + $5::int) % 250 + 1) || '/32',
            $4, 0.8, gen_random_uuid(), $2::bigint, $2::bigint + 86400000, $3, $2::bigint
     FROM generate_series(1, $1::int) g`,
    [n, at, over.actor ?? "operator1", over.source ?? "manual", manualSeq],
  );
  manualSeq += n;
}
