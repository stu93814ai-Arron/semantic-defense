import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

/** 5xx 一律固定 body 並寫 log（log 不含 request body／Authorization／cookie）；壞 JSON → 400 不外洩 parser 原文；其他 4xx 維持原 body。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

let lines: string[] = [];
async function boot(): Promise<ControlApi> {
  lines = [];
  app = await buildApp({
    idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(),
    logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } },
  });
  await seedPhase2Fixtures(app);
  return app;
}
async function admin(): Promise<string> {
  const r = await login(app, { username: "admin1", password: "pass-admin-1" });
  expect(r.status).toBe(200);
  return r.cookie!;
}
const BODY_MARKER = "body-marker-xyz";
const AUTH_MARKER = "Bearer auth-marker-xyz";

describe("control-api 5xx 錯誤處理", () => {
  it("DB 錯誤觸發的 500：body 固定、不含原文／約束名／表名；寫 error log；log 不含 body、Authorization、cookie", async () => {
    await boot();
    const c = await admin();
    await app.db.exec("ALTER TABLE audit_events ADD CONSTRAINT t_leak_probe CHECK (action <> 'thresholds.update') NOT VALID");
    let r;
    try {
      r = await app.inject({
        method: "PUT", url: ADMIN_API_PATHS.thresholds, headers: { ...cookieHeader(c), authorization: AUTH_MARKER },
        payload: { case: 0.6, auto: 0.95 },
      });
    } finally {
      await app.db.exec("ALTER TABLE audit_events DROP CONSTRAINT t_leak_probe");
    }
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: "伺服器錯誤" });
    for (const leak of ["t_leak_probe", "audit_events", "violates", "constraint", "relation", "23514"]) expect(r.body).not.toContain(leak);
    const errs = lines.map((l) => JSON.parse(l) as { level: number; err?: Record<string, unknown> }).filter((x) => x.level >= 50);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.err).toMatchObject({ code: "23514", constraint: "t_leak_probe" });
    const all = lines.join("\n");
    for (const s of ["auth-marker-xyz", c.split("=")[1]!, "pass-admin-1"]) expect(all).not.toContain(s);
  });

  it("route 內拋出含 body 內容的錯誤：log 也不帶 request body", async () => {
    lines = [];
    app = await buildApp({
      idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(),
      logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } },
      beforeReady: (a) => { a.post("/api/__boom", { config: { roles: "public" } }, async () => { throw new Error("boom"); }); },
    });
    const r = await app.inject({ method: "POST", url: "/api/__boom", headers: { authorization: AUTH_MARKER }, payload: { s: BODY_MARKER } });
    expect([r.statusCode, r.json()]).toEqual([500, { error: "伺服器錯誤" }]);
    expect(lines.some((l) => (JSON.parse(l) as { level: number }).level >= 50)).toBe(true);
    expect(lines.join("\n")).not.toContain(BODY_MARKER);
    expect(lines.join("\n")).not.toContain("auth-marker-xyz");
  });
});

describe("control-api 5xx log 不含請求資料（pg detail／message）", () => {
  it("稽核 CHECK 失敗：log 不含請求本文的值（pg 的 Failing row contains 會帶出）", async () => {
    await boot();
    const c = await admin();
    await app.db.exec("ALTER TABLE audit_events ADD CONSTRAINT t_leak_probe2 CHECK (action <> 'whitelist.create') NOT VALID");
    let r;
    try {
      r = await app.inject({ method: "POST", url: ADMIN_API_PATHS.whitelist, headers: cookieHeader(c),
        payload: { cidr: "10.0.0.0/8", reason: "reason-marker-q7", expires_at: null } });
    } finally {
      await app.db.exec("ALTER TABLE audit_events DROP CONSTRAINT t_leak_probe2");
    }
    expect([r.statusCode, r.json()]).toEqual([500, { error: "伺服器錯誤" }]);
    const errs = lines.map((l) => JSON.parse(l) as { level: number; err?: Record<string, unknown> }).filter((x) => x.level >= 50);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.err).toMatchObject({ code: "23514", constraint: "t_leak_probe2" });
    expect(lines.join("\n")).not.toContain("reason-marker-q7");
  });
});

describe("control-api 4xx", () => {
  it("壞 JSON → 400，body 固定、不外洩 parser 原文", async () => {
    await boot();
    const c = await admin();
    const parse = await app.inject({
      method: "PUT", url: ADMIN_API_PATHS.thresholds, headers: { ...cookieHeader(c), "content-type": "application/json" }, payload: "{not json",
    });
    expect(parse.statusCode).toBe(400);
    expect(parse.json()).toEqual({ error: "請求格式錯誤" });
    for (const leak of ["JSON", "Unexpected", "position", "token"]) expect(parse.body).not.toContain(leak);
  });

  it("其他 4xx 維持原 body：zod 400、404、401", async () => {
    await boot();
    const c = await admin();
    const bad = await app.inject({ method: "PUT", url: ADMIN_API_PATHS.thresholds, headers: cookieHeader(c), payload: { case: 2, auto: 1 } });
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: "請求格式錯誤" }]);
    expect((await app.inject({ method: "GET", url: "/nope" })).json()).toEqual({ error: "Not Found" });
    const anon = await app.inject({ method: "GET", url: ADMIN_API_PATHS.thresholds });
    expect(anon.statusCode).toBe(401);
  });
});
