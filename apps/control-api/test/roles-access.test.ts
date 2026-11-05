import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";

/**
 * 準則1：三種角色只達自己的資源；直打其他角色 API 被拒。
 */

const OPERATOR_GET = [
  "/api/judgments",
  "/api/judgments/history",
  "/api/judgments/case-fixture-1",
  "/api/constraints",
] as const;

const OWNER_GET = ["/api/apps/app-alpha", "/api/apps/app-alpha/map"] as const;

const ADMIN_GET = [
  "/api/admin/users",
  "/api/audit",
  "/api/versions",
  "/api/health",
] as const;

let app: ControlApi;

afterEach(async () => {
  if (app) await app.close();
});

async function boot(): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000 });
  await seedPhase2Fixtures(app);
  return app;
}

async function cookieFor(
  username: string,
  password: string,
): Promise<string> {
  const r = await login(app, { username, password });
  expect(r.status).toBe(200);
  expect(r.cookie).toBeTruthy();
  return r.cookie!;
}

describe("準則1：角色 API 隔離", () => {
  it("operator 可讀值勤 API，打管理／應用 API 為 403", async () => {
    await boot();
    const c = await cookieFor("operator1", "pass-operator-1");
    for (const url of OPERATOR_GET) {
      const res = await app.inject({ method: "GET", url, headers: cookieHeader(c) });
      expect([200, 404].includes(res.statusCode)).toBe(true);
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    }
    for (const url of [...OWNER_GET, ...ADMIN_GET]) {
      const res = await app.inject({ method: "GET", url, headers: cookieHeader(c) });
      expect(res.statusCode).toBe(403);
    }
  });

  it("app_owner 可讀己應用，打值勤／管理 API 為 403", async () => {
    await boot();
    const c = await cookieFor("owner1", "pass-owner-1");
    for (const url of OWNER_GET) {
      const res = await app.inject({ method: "GET", url, headers: cookieHeader(c) });
      expect(res.statusCode).toBe(200);
    }
    for (const url of [...OPERATOR_GET, ...ADMIN_GET]) {
      const res = await app.inject({ method: "GET", url, headers: cookieHeader(c) });
      expect(res.statusCode).toBe(403);
    }
  });

  it("platform_admin 可讀管理 API，打值勤／應用 API 為 403", async () => {
    await boot();
    const c = await cookieFor("admin1", "pass-admin-1");
    for (const url of ADMIN_GET) {
      const res = await app.inject({ method: "GET", url, headers: cookieHeader(c) });
      expect(res.statusCode).toBe(200);
    }
    for (const url of [...OPERATOR_GET, ...OWNER_GET]) {
      const res = await app.inject({ method: "GET", url, headers: cookieHeader(c) });
      expect(res.statusCode).toBe(403);
    }
  });
});
